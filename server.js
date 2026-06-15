import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { networkInterfaces } from 'node:os';

import {
  CodexIpcThreadStore,
  CodexIpcThreadStream,
  readCodexSnapshotFromProvider
} from './src/status.js';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4177);
const publicDir = join(import.meta.dirname, 'public');
const codexThreadStore = new CodexIpcThreadStore();
const codexThreadStream = new CodexIpcThreadStream(codexThreadStore);
codexThreadStream.start();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/status') {
      sendJson(
        res,
        readCodexSnapshotFromProvider(() => codexThreadStore.getThreadSummaries(), {
          yellowAfterMs: numberEnv('YELLOW_AFTER_MS'),
          activeWindowMs: numberEnv('ACTIVE_WINDOW_MS')
        })
      );
      return;
    }

    const filePath = resolvePublicFile(url.pathname);
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch (error) {
    if (req.url?.startsWith('/api/')) {
      sendJson(
        res,
        {
          generatedAt: new Date().toISOString(),
          total: 1,
          counts: { red: 0, yellow: 1, green: 0 },
          threads: [
            {
              id: 'status-source-error',
              title: '状态源读取失败',
              preview: error.message,
              cwd: '',
              status: 'error',
              light: 'yellow',
              ageMs: null,
              updatedAt: null
            }
          ]
        },
        500
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(port, host, () => {
  const urls = localUrls(port);
  console.log(`Codex traffic board listening:`);
  for (const url of urls) console.log(`  ${url}`);
});

function resolvePublicFile(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const cleanPath = decodeURIComponent(requested)
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  return join(publicDir, cleanPath);
}

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function contentType(path) {
  switch (extname(path)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'text/html; charset=utf-8';
  }
}

function localUrls(port) {
  const urls = [`http://localhost:${port}`];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return urls;
}

function numberEnv(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
