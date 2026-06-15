import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_YELLOW_AFTER_MS = 90_000;
export const DEFAULT_ACTIVE_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_MALFORMED_ACTIVE_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_UNFINISHED_ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const CODEX_IPC_THREAD_STREAM_VERSION = 7;

export function normalizeThread(
  raw,
  now = Date.now(),
  yellowAfterMs = DEFAULT_YELLOW_AFTER_MS,
  activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS
) {
  const updatedAtMs = toMs(raw.updatedAt ?? raw.updated_at ?? raw.updatedAtMs);
  const statusUpdatedAtMs = toMs(raw.statusUpdatedAt ?? raw.status_updated_at);
  const ageSourceMs = statusUpdatedAtMs ?? updatedAtMs;
  const ageMs = ageSourceMs ? Math.max(0, now - ageSourceMs) : null;
  const activeWindow = raw.activeWindowMs ?? activeWindowMs;
  let status = String(raw.status ?? 'idle');
  let light = 'green';

  if (status === 'active' && ageMs !== null && ageMs > activeWindow) {
    status = 'idle';
  }

  if (status === 'active') {
    light = 'red';
  }

  return {
    id: String(raw.id ?? ''),
    title: raw.title ?? raw.thread_name ?? 'Untitled Codex task',
    preview: raw.preview ?? '',
    cwd: raw.cwd ?? '',
    status,
    light,
    ageMs,
    updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null
  };
}

export function summarizeThreads(rawThreads, options = {}) {
  const now = options.now ?? Date.now();
  const yellowAfterMs = options.yellowAfterMs ?? DEFAULT_YELLOW_AFTER_MS;
  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const ignoredCwds = new Set((options.ignoredCwds ?? []).map(normalizeComparablePath));
  const threads = rawThreads
    .filter((thread) => !ignoredCwds.has(normalizeComparablePath(thread.cwd)))
    .map((thread) => normalizeThread(thread, now, yellowAfterMs, activeWindowMs));
  const active = threads.filter((thread) => thread.status === 'active');

  if (active.length === 0) {
    const visible = [
      {
        id: 'all-clear',
        title: 'Codex 空闲',
        preview: '当前没有正在运行的任务',
        cwd: '',
        status: 'idle',
        light: 'green',
        ageMs: null,
        updatedAt: null
      }
    ];

    return {
      generatedAt: new Date(now).toISOString(),
      yellowAfterMs,
      total: 1,
      counts: { red: 0, yellow: 0, green: 1 },
      threads: visible
    };
  }

  const counts = active.reduce(
    (acc, thread) => {
      acc[thread.light] += 1;
      return acc;
    },
    { red: 0, yellow: 0, green: 0 }
  );
  const light = counts.red > 0 ? 'red' : 'yellow';
  const activeCount = active.length;
  const visible = [
    {
      id: 'global-status',
      title: light === 'red' ? 'Codex 正在运行' : 'Codex 将要跑完',
      preview:
        light === 'red'
          ? `${activeCount} 个任务仍在运行`
          : `${activeCount} 个任务接近完成`,
      cwd: '',
      status: 'active',
      light,
      ageMs: Math.min(...active.map((thread) => thread.ageMs ?? 0)),
      updatedAt: null
    }
  ];

  return {
    generatedAt: new Date(now).toISOString(),
    yellowAfterMs,
    total: visible.length,
    counts,
    threads: visible
  };
}

export function summarizeThreadList(threadSummaries, options = {}) {
  return summarizeThreads(
    threadSummaries.map((thread) => ({
      id: thread.id,
      title: thread.title,
      preview: thread.preview ?? '',
      cwd: thread.cwd,
      status: thread.status,
      updatedAt: toMs(thread.updatedAt ?? thread.updated_at ?? thread.updatedAtMs)
    })),
    options
  );
}

export function readCodexSnapshotFromProvider(provider, options = {}) {
  try {
    const officialThreads = provider?.();

    if (Array.isArray(officialThreads)) {
      return readCodexSnapshot({
        ...options,
        officialThreads
      });
    }
  } catch {
    // Fall through to the historical fallback source below.
  }

  return readCodexSnapshot(options);
}

export function readSessionIndex(path = defaultSessionIndexPath()) {
  const text = readFileSync(path, 'utf8');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function readCodexSnapshot(options = {}) {
  const now = options.now ?? Date.now();
  const sessionIndexPath = options.sessionIndexPath ?? defaultSessionIndexPath();
  const globalStatePath = options.globalStatePath ?? defaultGlobalStatePath();
  const stateDbPath = options.stateDbPath ?? defaultStateDbPath();
  const recentLimit = options.recentLimit ?? 16;
  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const malformedActiveWindowMs =
    options.malformedActiveWindowMs ?? DEFAULT_MALFORMED_ACTIVE_WINDOW_MS;
  const unfinishedActiveWindowMs =
    options.unfinishedActiveWindowMs ?? DEFAULT_UNFINISHED_ACTIVE_WINDOW_MS;
  const yellowAfterMs = options.yellowAfterMs ?? DEFAULT_YELLOW_AFTER_MS;
  const hasOfficialThreads = Array.isArray(options.officialThreads);
  const recent = hasOfficialThreads
    ? options.officialThreads.slice(0, recentLimit)
    : readRecentThreads({
        stateDbPath,
        sessionIndexPath,
        recentLimit,
        malformedActiveWindowMs,
        unfinishedActiveWindowMs
      });

  const globalStateMtime = tryMtime(globalStatePath);
  const ignoredCwds = options.ignoredCwds ?? [];
  const source = {
    stateDbPath,
    sessionIndexPath,
    globalStatePath,
    globalStateUpdatedAt: globalStateMtime ? globalStateMtime.toISOString() : null,
    ignoredCwds,
    activeWindowMs,
    malformedActiveWindowMs,
    unfinishedActiveWindowMs,
    statusPriority: hasOfficialThreads ? 'official' : 'fallback',
    note: hasOfficialThreads
      ? 'Codex desktop runtime status is read from live IPC thread-stream-state-changed snapshots.'
      : 'Codex desktop runtime status is inferred from rollout task_started/task_complete events when available; malformed active rollouts use a short metadata freshness window because later writes may be unreadable.'
  };

  return {
    ...summarizeThreads(recent, {
      now,
      yellowAfterMs,
      activeWindowMs: hasOfficialThreads ? Number.POSITIVE_INFINITY : activeWindowMs,
      ignoredCwds
    }),
    source
  };
}

export class CodexIpcThreadStore {
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.threads = new Map();
    this.ready = false;
    this.hasSnapshot = false;
    this.connectedAtMs = null;
    this.lastMessageAtMs = null;
  }

  markConnected(now = this.now()) {
    this.ready = true;
    this.connectedAtMs = now;
    this.lastMessageAtMs = now;
    if (!this.hasSnapshot) this.threads.clear();
  }

  markDisconnected() {
    this.ready = false;
  }

  applyMessage(message, now = this.now()) {
    if (message?.type !== 'broadcast') return false;
    if (message.method !== 'thread-stream-state-changed') return false;
    if (message.version != null && message.version !== CODEX_IPC_THREAD_STREAM_VERSION) return false;

    const params = message.params ?? {};
    const conversationId = params.conversationId;
    const change = params.change;
    if (!conversationId || params.hostId !== 'local' || !change) return false;

    this.ready = true;
    this.lastMessageAtMs = now;

    if (change.type === 'snapshot' && change.conversationState) {
      this.threads.set(conversationId, {
        revision: change.revision ?? null,
        receivedAtMs: now,
        state: change.conversationState
      });
      this.hasSnapshot = true;
      return true;
    }

    if (change.type === 'patches') {
      const entry = this.threads.get(conversationId);
      if (!entry) return false;
      if (
        entry.revision !== null &&
        change.baseRevision != null &&
        entry.revision !== change.baseRevision
      ) {
        return false;
      }

      entry.state = applyJsonPatches(entry.state, change.patches ?? []);
      entry.revision = change.revision ?? entry.revision;
      entry.receivedAtMs = now;
      return true;
    }

    return false;
  }

  getThreadSummaries() {
    if (!this.hasSnapshot) return null;

    return Array.from(this.threads.values())
      .map(({ state, receivedAtMs }) => conversationStateToThreadSummary(state, receivedAtMs))
      .filter(Boolean);
  }
}

export class CodexIpcThreadStream {
  constructor(store, options = {}) {
    this.store = store;
    this.pipePath = options.pipePath ?? defaultCodexIpcPipePath();
    this.clientType = options.clientType ?? `codex-traffic-board-${randomUUID()}`;
    this.reconnectMs = options.reconnectMs ?? 1000;
    this.socket = null;
    this.started = false;
    this.reconnectTimer = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop() {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
    this.store.markDisconnected();
  }

  connect() {
    if (!this.started || this.socket) return;

    const socket = connect(this.pipePath);
    this.socket = socket;
    attachIpcMessageReader(socket, (message) => this.handleMessage(message));

    socket.on('connect', () => {
      this.write({
        type: 'request',
        requestId: 'initialize',
        sourceClientId: 'initializing-client',
        version: 0,
        method: 'initialize',
        params: { clientType: this.clientType }
      });
    });

    socket.on('error', () => {
      socket.destroy();
    });

    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.store.markDisconnected();
      if (!this.started || this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectMs);
      this.reconnectTimer.unref?.();
    });
  }

  handleMessage(message) {
    if (message?.type === 'response' && message.method === 'initialize') {
      if (message.resultType === 'success') this.store.markConnected();
      return;
    }

    if (message?.type === 'client-discovery-request') {
      this.write({
        type: 'client-discovery-response',
        requestId: message.requestId,
        response: { canHandle: false }
      });
      return;
    }

    this.store.applyMessage(message);
  }

  write(message) {
    if (!this.socket?.writable) return;
    this.socket.write(encodeIpcFrame(message));
  }
}


export function readRecentThreads(options = {}) {
  const recentLimit = options.recentLimit ?? 16;

  try {
    return readRecentThreadsFromSqlite(options.stateDbPath ?? defaultStateDbPath(), recentLimit, {
      malformedActiveWindowMs:
        options.malformedActiveWindowMs ?? DEFAULT_MALFORMED_ACTIVE_WINDOW_MS,
      unfinishedActiveWindowMs:
        options.unfinishedActiveWindowMs ?? DEFAULT_UNFINISHED_ACTIVE_WINDOW_MS
    });
  } catch {
    return readSessionIndex(options.sessionIndexPath ?? defaultSessionIndexPath())
      .map((thread) => ({
        id: thread.id,
        title: thread.thread_name,
        preview: '',
        cwd: '',
        updatedAt: thread.updated_at
      }))
      .sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt))
      .slice(0, recentLimit);
  }
}

export function readRecentThreadsFromSqlite(path, limit = 16, options = {}) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        `select id, title, preview, cwd, rollout_path, updated_at, updated_at_ms
         from threads
         where archived = 0
           and coalesce(thread_source, 'user') <> 'subagent'
           and id not in (select child_thread_id from thread_spawn_edges)
         order by coalesce(updated_at_ms, updated_at * 1000) desc
         limit ?`
      )
      .all(limit)
      .map((thread) => {
        const runtime = readRolloutRuntimeStatus(cleanWindowsPath(thread.rollout_path));

        return {
          id: thread.id,
          title: thread.title,
          preview: thread.preview,
          cwd: cleanWindowsPath(thread.cwd),
          updatedAt: thread.updated_at_ms ?? thread.updated_at * 1000,
          statusUpdatedAt: newerTime(
            runtime?.statusUpdatedAt,
            thread.updated_at_ms ?? thread.updated_at * 1000
          ),
          status: runtime?.status,
          activeWindowMs: runtime?.hasMalformedLines
            ? options.malformedActiveWindowMs
            : runtime?.status === 'active'
              ? options.unfinishedActiveWindowMs
              : undefined
        };
      });
  } finally {
    db.close();
  }
}

function defaultSessionIndexPath() {
  return join(homedir(), '.codex', 'session_index.jsonl');
}

function defaultGlobalStatePath() {
  return join(homedir(), '.codex', '.codex-global-state.json');
}

function defaultStateDbPath() {
  return join(homedir(), '.codex', 'state_5.sqlite');
}

function defaultCodexIpcPipePath() {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\codex-ipc'
    : join(homedir(), '.codex', 'codex-ipc.sock');
}

function toMs(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function tryMtime(path) {
  try {
    return statSync(path).mtime;
  } catch {
    return null;
  }
}

function cleanWindowsPath(path) {
  return String(path ?? '').replace(/^\\\\\?\\/, '');
}

function normalizeComparablePath(path) {
  return cleanWindowsPath(path).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function readRolloutRuntimeStatus(path) {
  if (!path) return undefined;

  try {
    const text = readFileSync(path, 'utf8');
    let latestRuntimeEvent = null;
    let malformedAfterLatestRuntimeEvent = false;
    let latestActivityAt = null;

    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        malformedAfterLatestRuntimeEvent = true;
        continue;
      }
      latestActivityAt = taskLifecycleTimeMs(event.payload, event) ?? latestActivityAt;

      if (event.type === 'turn_context' && event.payload?.turn_id) {
        latestRuntimeEvent = {
          type: 'turn_context',
          status: 'active',
          updatedAt: taskLifecycleTimeMs(undefined, event)
        };
        malformedAfterLatestRuntimeEvent = false;
        continue;
      }

      const payload = event.payload;
      if (event.type !== 'event_msg') continue;

      if (payload?.type === 'turn_aborted') {
        latestRuntimeEvent = {
          type: payload.type,
          status: 'idle',
          updatedAt: taskLifecycleTimeMs(payload, event)
        };
        malformedAfterLatestRuntimeEvent = false;
        continue;
      }

      if (!payload?.turn_id) continue;

      if (
        payload.type === 'task_started' ||
        payload.type === 'task_complete' ||
        payload.type === 'task_interrupted' ||
        payload.type === 'task_failed'
      ) {
        latestRuntimeEvent = {
          type: payload.type,
          status: payload.type === 'task_started' ? 'active' : 'idle',
          updatedAt: taskLifecycleTimeMs(payload, event)
        };
        malformedAfterLatestRuntimeEvent = false;
      }
    }

    return {
      status: latestRuntimeEvent?.status ?? 'idle',
      statusUpdatedAt:
        latestRuntimeEvent?.status === 'active' && !malformedAfterLatestRuntimeEvent
          ? latestActivityAt
          : undefined,
      hasMalformedLines: malformedAfterLatestRuntimeEvent
    };
  } catch {
    return undefined;
  }
}

function taskLifecycleTimeMs(payload, event) {
  const value =
    payload?.started_at ??
    payload?.completed_at ??
    payload?.interrupted_at ??
    payload?.failed_at ??
    event.timestamp;

  if (typeof value === 'number') {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  return toMs(value);
}

function newerTime(left, right) {
  const leftMs = toMs(left);
  const rightMs = toMs(right);

  if (leftMs === null) return rightMs;
  if (rightMs === null) return leftMs;
  return Math.max(leftMs, rightMs);
}

function conversationStateToThreadSummary(state, receivedAtMs) {
  if (!state?.id) return null;

  return {
    id: state.id,
    title: state.title,
    preview: state.preview ?? '',
    cwd: cleanWindowsPath(state.cwd),
    status: conversationRuntimeStatus(state),
    updatedAt: receivedAtMs
  };
}

function conversationRuntimeStatus(state) {
  const runtimeType = state.threadRuntimeStatus?.type;
  if (runtimeType === 'active') return 'active';
  if (runtimeType === 'systemError') return 'systemError';
  if (runtimeType === 'notLoaded') return 'notLoaded';
  if (runtimeType === 'idle') return 'idle';

  if (state.resumeState === 'needs_resume') {
    return runtimeType === 'active' ? 'active' : 'notLoaded';
  }

  const lastTurn = Array.isArray(state.turns) ? state.turns.at(-1) : null;
  if (!lastTurn) return state.resumeState === 'resuming' ? 'active' : 'idle';
  return lastTurn.status === 'inProgress' ? 'active' : 'idle';
}

function applyJsonPatches(value, patches) {
  let next = structuredClone(value);

  for (const patch of patches) {
    next = applyJsonPatch(next, patch);
  }

  return next;
}

function applyJsonPatch(value, patch) {
  const path = Array.isArray(patch.path) ? patch.path : [];
  if (path.length === 0) {
    if (patch.op === 'remove') return undefined;
    return structuredClone(patch.value);
  }

  const next = value;
  const parent = path.slice(0, -1).reduce((target, key) => target?.[key], next);
  if (parent == null) return next;

  const key = path.at(-1);
  switch (patch.op) {
    case 'add':
      if (Array.isArray(parent)) {
        parent.splice(key === '-' ? parent.length : Number(key), 0, structuredClone(patch.value));
      } else {
        parent[key] = structuredClone(patch.value);
      }
      break;
    case 'replace':
      parent[key] = structuredClone(patch.value);
      break;
    case 'remove':
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
      break;
    default:
      break;
  }

  return next;
}

function attachIpcMessageReader(socket, onMessage) {
  const header = Buffer.allocUnsafe(4);
  let headerOffset = 0;
  let body = null;
  let bodyOffset = 0;

  socket.on('data', (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (!body) {
        const copied = chunk.copy(header, headerOffset, offset, offset + 4 - headerOffset);
        headerOffset += copied;
        offset += copied;
        if (headerOffset < 4) return;

        const frameLength = header.readUInt32LE(0);
        headerOffset = 0;
        if (frameLength <= 0 || frameLength > 256 * 1024 * 1024) {
          socket.destroy();
          return;
        }
        body = Buffer.allocUnsafe(frameLength);
        bodyOffset = 0;
      }

      const copied = chunk.copy(body, bodyOffset, offset, offset + body.length - bodyOffset);
      bodyOffset += copied;
      offset += copied;
      if (bodyOffset < body.length) return;

      const frame = body;
      body = null;
      bodyOffset = 0;

      try {
        onMessage(JSON.parse(frame.toString('utf8')));
      } catch {
        socket.destroy();
        return;
      }
    }
  });
}

function encodeIpcFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}
