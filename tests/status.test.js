import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import {
  CodexIpcThreadStore,
  normalizeThread,
  readCodexSnapshotFromProvider,
  readCodexSnapshot,
  readRecentThreads,
  readRecentThreadsFromSqlite,
  summarizeThreadList,
  summarizeThreads
} from '../src/status.js';

const serverJs = readFileSync('server.js', 'utf8');

test('active recently updated threads are red', () => {
  const now = Date.parse('2026-06-11T01:00:00.000Z');
  const thread = normalizeThread(
    {
      id: '1',
      title: 'Running',
      status: 'active',
      updatedAt: '2026-06-11T00:59:20.000Z'
    },
    now,
    90_000
  );

  assert.equal(thread.light, 'red');
});

test('active threads remain red until the active window expires', () => {
  const now = Date.parse('2026-06-11T01:00:00.000Z');
  const thread = normalizeThread(
    {
      id: '1',
      title: 'Still running',
      status: 'active',
      updatedAt: '2026-06-11T00:57:00.000Z'
    },
    now,
    90_000,
    10 * 60 * 1000
  );

  assert.equal(thread.status, 'active');
  assert.equal(thread.light, 'red');
});

test('idle and unloaded threads are green', () => {
  const now = Date.parse('2026-06-11T01:00:00.000Z');

  assert.equal(normalizeThread({ status: 'idle' }, now).light, 'green');
  assert.equal(normalizeThread({ status: 'notLoaded' }, now).light, 'green');
});

test('recent sqlite metadata alone stays idle without runtime status', () => {
  const now = Date.parse('2026-06-11T01:00:00.000Z');
  const thread = normalizeThread(
    {
      id: 'recent-metadata-only',
      title: 'Recently updated',
      updatedAt: '2026-06-11T00:59:30.000Z'
    },
    now,
    90_000,
    10 * 60 * 1000
  );

  assert.equal(thread.status, 'idle');
  assert.equal(thread.light, 'green');
});

test('summary shows a single all-clear item when nothing is active', () => {
  const summary = summarizeThreads(
    [
      { id: '1', title: 'Past', status: 'idle' },
      { id: '2', title: 'Closed', status: 'notLoaded' }
    ],
    { now: Date.parse('2026-06-11T01:00:00.000Z') }
  );

  assert.equal(summary.total, 1);
  assert.equal(summary.threads[0].id, 'all-clear');
  assert.equal(summary.threads[0].light, 'green');
});

test('summary returns a single highest-priority status panel', () => {
  const now = Date.parse('2026-06-11T01:00:00.000Z');
  const summary = summarizeThreads(
    [
      { id: '1', title: 'A', status: 'active', updatedAt: '2026-06-11T00:59:30.000Z' },
      { id: '2', title: 'B', status: 'active', updatedAt: '2026-06-11T00:55:00.000Z' },
      { id: '3', title: 'C', status: 'idle' }
    ],
    { now, yellowAfterMs: 90_000 }
  );

  assert.equal(summary.total, 1);
  assert.deepEqual(summary.counts, { red: 2, yellow: 0, green: 0 });
  assert.equal(summary.threads.length, 1);
  assert.equal(summary.threads[0].id, 'global-status');
  assert.equal(summary.threads[0].light, 'red');
  assert.equal(summary.threads[0].title, 'Codex 正在运行');
});

test('summary can ignore the monitor workspace active thread', () => {
  const now = Date.parse('2026-06-11T01:00:00.000Z');
  const summary = summarizeThreads(
    [
      {
        id: 'monitor-thread',
        title: 'Traffic board maintenance',
        cwd: '\\\\?\\D:\\workSotre\\lamp',
        status: 'active',
        updatedAt: '2026-06-11T00:59:55.000Z'
      },
      {
        id: 'external-thread',
        title: 'Actual user task',
        cwd: 'D:\\workSotre\\mc-harness-prd',
        status: 'active',
        updatedAt: '2026-06-11T00:59:50.000Z'
      }
    ],
    { now, ignoredCwds: ['D:/workSotre/lamp/'] }
  );

  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].preview, '1 个任务仍在运行');
});

test('served status includes the monitor thread by default', () => {
  assert.doesNotMatch(serverJs, /ignoredCwds:\s*\[import\.meta\.dirname\]/);
});

test('summary can use Codex thread list statuses directly', () => {
  const summary = summarizeThreadList(
    [
      {
        id: 'current',
        title: 'Current monitor conversation',
        cwd: 'D:\\workSotre\\lamp',
        status: 'active',
        updatedAt: 1_781_160_100
      },
      {
        id: 'other-running',
        title: 'Other running task',
        cwd: 'D:\\workSotre\\mc-harness-prd',
        status: 'active',
        updatedAt: 1_781_160_000
      },
      {
        id: 'loaded-idle',
        title: 'Idle loaded task',
        cwd: 'D:\\workSotre\\businessmgr',
        status: 'idle',
        updatedAt: 1_781_159_000
      },
      {
        id: 'old-not-loaded',
        title: 'Old task',
        cwd: 'D:\\workSotre\\businessmgr',
        status: 'notLoaded',
        updatedAt: 1_781_158_000
      }
    ],
    { now: 1_781_160_500_000 }
  );

  assert.deepEqual(summary.counts, { red: 2, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].preview, '2 个任务仍在运行');
});

test('IPC thread store snapshots provide official active counts', () => {
  const store = new CodexIpcThreadStore();
  store.applyMessage({
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    version: 7,
    params: {
      conversationId: 'running-thread',
      hostId: 'local',
      change: {
        type: 'snapshot',
        revision: 1,
        conversationState: {
          id: 'running-thread',
          title: 'Running from Desktop',
          cwd: 'D:\\workSotre\\businessmgr',
          updatedAt: 1_781_160_100_000,
          resumeState: 'resumed',
          turns: [
            {
              status: 'inProgress',
              items: []
            }
          ]
        }
      }
    }
  });

  const summary = readCodexSnapshotFromProvider(() => store.getThreadSummaries(), {
    now: 1_781_160_500_000
  });

  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].preview, '1 个任务仍在运行');
  assert.equal(summary.source.statusPriority, 'official');
});

test('IPC thread store is not authoritative before the first snapshot', () => {
  const store = new CodexIpcThreadStore();

  store.markConnected();

  assert.equal(store.getThreadSummaries(), null);
});

test('IPC thread store remains authoritative after disconnect once snapshot was received', () => {
  const store = new CodexIpcThreadStore();
  store.applyMessage({
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    version: 7,
    params: {
      conversationId: 'running-before-disconnect',
      hostId: 'local',
      change: {
        type: 'snapshot',
        revision: 1,
        conversationState: {
          id: 'running-before-disconnect',
          title: 'Running before disconnect',
          cwd: 'D:\\workSotre\\businessmgr',
          resumeState: 'resumed',
          turns: [
            {
              status: 'inProgress',
              items: []
            }
          ]
        }
      }
    }
  });

  store.markDisconnected();
  const summary = readCodexSnapshotFromProvider(() => store.getThreadSummaries(), {
    now: 1_781_160_500_000
  });

  assert.equal(summary.source.statusPriority, 'official');
  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
});

test('IPC thread store remains authoritative while reconnect waits for a fresh snapshot', () => {
  const store = new CodexIpcThreadStore();
  store.applyMessage({
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    version: 7,
    params: {
      conversationId: 'running-before-reconnect',
      hostId: 'local',
      change: {
        type: 'snapshot',
        revision: 1,
        conversationState: {
          id: 'running-before-reconnect',
          title: 'Running before reconnect',
          cwd: 'D:\\workSotre\\businessmgr',
          resumeState: 'resumed',
          turns: [
            {
              status: 'inProgress',
              items: []
            }
          ]
        }
      }
    }
  });

  store.markDisconnected();
  store.markConnected();
  const summary = readCodexSnapshotFromProvider(() => store.getThreadSummaries(), {
    now: 1_781_160_500_000
  });

  assert.equal(summary.source.statusPriority, 'official');
  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
});

test('IPC thread store applies completion patches before summarizing', () => {
  const store = new CodexIpcThreadStore();
  store.applyMessage({
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    version: 7,
    params: {
      conversationId: 'finishing-thread',
      hostId: 'local',
      change: {
        type: 'snapshot',
        revision: 1,
        conversationState: {
          id: 'finishing-thread',
          title: 'Finishing from Desktop',
          cwd: 'D:\\workSotre\\lamp',
          updatedAt: 1_781_160_100_000,
          resumeState: 'resumed',
          turns: [
            {
              status: 'inProgress',
              items: []
            }
          ]
        }
      }
    }
  });
  store.applyMessage({
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    version: 7,
    params: {
      conversationId: 'finishing-thread',
      hostId: 'local',
      change: {
        type: 'patches',
        baseRevision: 1,
        revision: 2,
        patches: [
          {
            op: 'replace',
            path: ['turns', 0, 'status'],
            value: 'completed'
          }
        ]
      }
    }
  });

  const summary = readCodexSnapshotFromProvider(() => store.getThreadSummaries(), {
    now: 1_781_160_500_000
  });

  assert.deepEqual(summary.counts, { red: 0, yellow: 0, green: 1 });
  assert.equal(summary.threads[0].id, 'all-clear');
});

test('snapshot prefers official thread status over rollout fallback status', () => {
  const dir = join(tmpdir(), `codex-traffic-board-official-priority-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-active-but-official-idle.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'official-idle',
    'Fallback thinks active',
    'D:\\work',
    rolloutPath,
    1_781_145_399,
    1_781_145_399_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: '2026-06-11T00:59:59.000Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1' }
    })}\n`,
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_400_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    officialThreads: [
      {
        id: 'official-idle',
        title: 'Official idle',
        preview: '',
        cwd: 'D:\\work',
        status: 'notLoaded',
        updatedAt: 1_781_145_399
      }
    ]
  });

  assert.deepEqual(summary.counts, { red: 0, yellow: 0, green: 1 });
  assert.equal(summary.threads[0].id, 'all-clear');
  assert.equal(summary.source.statusPriority, 'official');
});

test('snapshot uses recent rollout activity when sqlite metadata is stale', () => {
  const dir = join(tmpdir(), `codex-traffic-board-stale-sqlite-fresh-rollout-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-fresh-response.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'stale-sqlite-fresh-rollout',
    'Fresh rollout',
    'D:\\work',
    rolloutPath,
    1_781_144_000,
    1_781_144_000_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: '2026-06-11T00:40:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1',
          started_at: '2026-06-11T00:40:00.000Z'
        }
      }),
      JSON.stringify({
        timestamp: '2026-06-11T00:59:59.000Z',
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'call-1' }
      })
    ].join('\n'),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: Date.parse('2026-06-11T01:00:00.000Z'),
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000
  });

  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].preview, '1 个任务仍在运行');
});

test('snapshot ignores sqlite updates outside the active window', () => {
  const dir = join(tmpdir(), `codex-traffic-board-snapshot-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, 0, ?)`
  ).run(
    'old-metadata-only',
    'Old metadata update',
    'D:\\work',
    1_781_144_700,
    1_781_144_700_000,
    'user'
  );
  db.close();
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_400_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000
  });

  assert.equal(summary.total, 1);
  assert.equal(summary.threads[0].id, 'all-clear');
  assert.equal(summary.threads[0].light, 'green');
});

test('recent thread reader falls back to session index when sqlite is unavailable', () => {
  const dir = join(tmpdir(), `codex-traffic-board-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  writeFileSync(
    sessionIndexPath,
    [
      JSON.stringify({
        id: 'older',
        thread_name: 'Older task',
        updated_at: '2026-06-10T01:00:00.000Z'
      }),
      JSON.stringify({
        id: 'newer',
        thread_name: 'Newer task',
        updated_at: '2026-06-11T01:00:00.000Z'
      })
    ].join('\n'),
    'utf8'
  );

  const threads = readRecentThreads({
    stateDbPath: join(dir, 'missing.sqlite'),
    sessionIndexPath,
    recentLimit: 1
  });

  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, 'newer');
});

test('snapshot treats unfinished rollout turns as active work', () => {
  const dir = join(tmpdir(), `codex-traffic-board-active-rollout-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-active.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'active-rollout',
    'Active rollout',
    'D:\\work',
    rolloutPath,
    1_781_145_360,
    1_781_145_360_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: '2026-06-11T00:59:30.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_781_145_370 }
    })}\n`,
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_400_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000
  });

  assert.equal(summary.total, 1);
  assert.equal(summary.threads[0].id, 'global-status');
  assert.equal(summary.threads[0].light, 'red');
});

test('snapshot keeps active rollout status when trailing rollout lines are corrupted', () => {
  const dir = join(tmpdir(), `codex-traffic-board-corrupt-rollout-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-corrupt-tail.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'corrupt-active-rollout',
    'Corrupt active rollout',
    'D:\\work',
    rolloutPath,
    1_781_145_395,
    1_781_145_395_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: '2026-06-11T00:59:56.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_781_145_396 }
      }),
      JSON.stringify({
        timestamp: '2026-06-11T00:59:58.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: 1 } }
      }),
      '\0\0\0not-json'
    ].join('\n'),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_400_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000
  });

  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].light, 'red');
});

test('snapshot expires malformed active rollout when sqlite metadata is stale', () => {
  const dir = join(tmpdir(), `codex-traffic-board-corrupt-short-window-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-corrupt-short-window.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'corrupt-stale-active-rollout',
    'Corrupt stale active rollout',
    'D:\\work',
    rolloutPath,
    1_781_145_220,
    1_781_145_220_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: '2026-06-11T00:57:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_781_145_220 }
      }),
      '\0\0not-json',
      JSON.stringify({
        timestamp: '2026-06-11T00:57:10.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: 1 } }
      })
    ].join('\n'),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_400_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000,
    malformedActiveWindowMs: 90_000
  });

  assert.deepEqual(summary.counts, { red: 0, yellow: 0, green: 1 });
  assert.equal(summary.threads[0].id, 'all-clear');
});

test('snapshot keeps malformed rollout active within the default window', () => {
  const dir = join(tmpdir(), `codex-traffic-board-corrupt-default-window-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-corrupt-default-window.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'corrupt-default-window',
    'Corrupt default window',
    'D:\\work',
    rolloutPath,
    1_781_145_385,
    1_781_145_385_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: '2026-06-11T00:59:30.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_781_145_370 }
      }),
      '\0\0not-json'
    ].join('\n'),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_400_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000
  });

  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].id, 'global-status');
});

test('snapshot keeps malformed active rollout active when sqlite metadata is fresh', () => {
  const dir = join(tmpdir(), `codex-traffic-board-corrupt-fresh-metadata-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-corrupt-fresh-metadata.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'corrupt-fresh-active-rollout',
    'Corrupt fresh active rollout',
    'D:\\work',
    rolloutPath,
    1_781_145_399,
    1_781_145_399_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: '2026-06-11T00:57:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_781_145_220 }
      }),
      '\0\0not-json',
      JSON.stringify({
        timestamp: '2026-06-11T00:59:59.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: 1 } }
      })
    ].join('\n'),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_400_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000,
    malformedActiveWindowMs: 90_000
  });

  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].id, 'global-status');
});

test('snapshot keeps malformed active rollout active when unreadable tail refreshes metadata', () => {
  const dir = join(tmpdir(), `codex-traffic-board-corrupt-unreadable-tail-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-corrupt-unreadable-tail.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'corrupt-unreadable-tail',
    'Corrupt unreadable tail',
    'D:\\work',
    rolloutPath,
    1_781_145_399,
    1_781_145_399_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: '2026-06-11T00:57:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_781_145_220 }
      }),
      '\0\0not-json',
      'still-not-json'
    ].join('\n'),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_400_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000,
    malformedActiveWindowMs: 90_000
  });

  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].id, 'global-status');
});

test('snapshot keeps long running valid rollout active when metadata is fresh', () => {
  const dir = join(tmpdir(), `codex-traffic-board-long-valid-rollout-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-long-valid.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'long-valid-rollout',
    'Long valid rollout',
    'D:\\work',
    rolloutPath,
    1_781_145_399,
    1_781_145_399_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: '2026-06-11T00:40:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_781_144_799 }
      }),
      JSON.stringify({
        timestamp: '2026-06-11T00:59:59.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: 1 } }
      })
    ].join('\n'),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_400_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000
  });

  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].id, 'global-status');
});

test('snapshot keeps valid unfinished rollout active without recent activity', () => {
  const dir = join(tmpdir(), `codex-traffic-board-valid-unfinished-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-valid-unfinished.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'valid-unfinished-rollout',
    'Valid unfinished rollout',
    'D:\\work',
    rolloutPath,
    Date.parse('2026-06-11T00:30:00.000Z') / 1000,
    Date.parse('2026-06-11T00:30:00.000Z'),
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    JSON.stringify({
      timestamp: '2026-06-11T00:40:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-1',
        started_at: '2026-06-11T00:40:00.000Z'
      }
    }),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: Date.parse('2026-06-11T01:00:00.000Z'),
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000
  });

  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].preview, '1 个任务仍在运行');
});

test('snapshot expires malformed active rollout without a later completion event', () => {
  const dir = join(tmpdir(), `codex-traffic-board-stale-lifecycle-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-stale-lifecycle.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'stale-lifecycle-rollout',
    'Stale lifecycle rollout',
    'D:\\work',
    rolloutPath,
    1_781_144_799,
    1_781_144_799_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: '2026-06-11T00:40:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_781_144_799 }
      }),
      '\0\0not-json',
      JSON.stringify({
        timestamp: '2026-06-11T00:59:59.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: 1 } }
      })
    ].join('\n'),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_400_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000
  });

  assert.deepEqual(summary.counts, { red: 0, yellow: 0, green: 1 });
  assert.equal(summary.threads[0].id, 'all-clear');
});

test('snapshot ignores recent sqlite updates when rollout turn completed', () => {
  const dir = join(tmpdir(), `codex-traffic-board-completed-rollout-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-completed.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'completed-rollout',
    'Completed rollout',
    'D:\\work',
    rolloutPath,
    1_781_145_390,
    1_781_145_390_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: '2026-06-11T00:50:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'old-interrupted-turn', started_at: 1_781_144_800 }
      }),
      JSON.stringify({
        timestamp: '2026-06-11T00:59:30.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_781_145_370 }
      }),
      JSON.stringify({
        timestamp: '2026-06-11T00:59:50.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1', completed_at: 1_781_145_390 }
      })
    ].join('\n'),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_400_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000
  });

  assert.equal(summary.total, 1);
  assert.equal(summary.threads[0].id, 'all-clear');
  assert.equal(summary.threads[0].light, 'green');
});

test('snapshot treats a submitted turn as active before task_started is written', () => {
  const dir = join(tmpdir(), `codex-traffic-board-submitted-turn-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-submitted-turn.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'submitted-turn',
    'Submitted turn',
    'D:\\work',
    rolloutPath,
    1_781_145_399,
    1_781_145_399_000,
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: '2026-06-11T00:50:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1_781_144_800 }
      }),
      JSON.stringify({
        timestamp: '2026-06-11T00:55:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1', completed_at: 1_781_145_100 }
      }),
      '\0\0not-json',
      JSON.stringify({
        timestamp: 1_781_145_399,
        type: 'turn_context',
        payload: { turn_id: 'turn-2' }
      }),
      JSON.stringify({
        timestamp: 1_781_145_399,
        type: 'event_msg',
        payload: { type: 'user_message', message: 'run' }
      })
    ].join('\n'),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: 1_781_145_460_000,
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000
  });

  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].id, 'global-status');
});

test('snapshot uses fresh activity after older malformed rollout lines', () => {
  const dir = join(tmpdir(), `codex-traffic-board-recovered-rollout-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const sessionIndexPath = join(dir, 'session_index.jsonl');
  const globalStatePath = join(dir, 'global-state.json');
  const rolloutPath = join(dir, 'rollout-recovered-after-malformed.jsonl');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run(
    'recovered-rollout',
    'Recovered rollout',
    'D:\\work',
    rolloutPath,
    Date.parse('2026-06-11T00:30:00.000Z') / 1000,
    Date.parse('2026-06-11T00:30:00.000Z'),
    'user'
  );
  db.close();
  writeFileSync(
    rolloutPath,
    [
      '\0\0older-not-json',
      JSON.stringify({
        timestamp: '2026-06-11T00:59:59.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-2' }
      }),
      JSON.stringify({
        timestamp: '2026-06-11T00:59:59.000Z',
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'call-1' }
      })
    ].join('\n'),
    'utf8'
  );
  writeFileSync(sessionIndexPath, '', 'utf8');
  writeFileSync(globalStatePath, '{}', 'utf8');

  const summary = readCodexSnapshot({
    now: Date.parse('2026-06-11T01:00:00.000Z'),
    stateDbPath: dbPath,
    sessionIndexPath,
    globalStatePath,
    activeWindowMs: 10 * 60 * 1000
  });

  assert.deepEqual(summary.counts, { red: 1, yellow: 0, green: 0 });
  assert.equal(summary.threads[0].id, 'global-status');
});

test('sqlite reader excludes spawned subagent threads from top-level task count', () => {
  const dir = join(tmpdir(), `codex-traffic-board-sqlite-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'state.sqlite');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table threads (
      id text primary key,
      title text not null,
      preview text not null default '',
      cwd text not null,
      rollout_path text,
      updated_at integer not null,
      updated_at_ms integer,
      archived integer not null default 0,
      thread_source text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run('parent', 'Parent task', 'D:\\work', null, 100, 100_000, 'user');
  db.prepare(
    `insert into threads
     (id, title, preview, cwd, rollout_path, updated_at, updated_at_ms, archived, thread_source)
     values (?, ?, '', ?, ?, ?, ?, 0, ?)`
  ).run('child', 'Subagent task', 'D:\\work', null, 101, 101_000, 'subagent');
  db.prepare(
    'insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, ?)'
  ).run('parent', 'child', 'open');
  db.close();

  const threads = readRecentThreadsFromSqlite(dbPath, 10);

  assert.deepEqual(
    threads.map((thread) => thread.id),
    ['parent']
  );
});
