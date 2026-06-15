import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const css = readFileSync('public/styles.css', 'utf8');
const js = readFileSync('public/app.js', 'utf8');

test('iphone landscape layout keeps the single global signal centered', () => {
  assert.match(css, /max-height:\s*460px/);
  assert.match(css, /orientation:\s*landscape/);
  assert.doesNotMatch(css, /--panel-count/);
  assert.match(css, /justify-items:\s*center/);
});

test('global status title is not per-task truncated', () => {
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.doesNotMatch(js, /compactTitle/);
});

test('footer clock updates independently from status polling', () => {
  assert.doesNotMatch(js, /setInterval\(updateClock,\s*1000\)/);
  assert.match(js, /setTimeout\(tickClock,\s*1000\)/);
  assert.match(js, /data-clock/);
});

test('traffic board renders one global status instead of compact multi-task panels', () => {
  assert.doesNotMatch(js, /is-compact/);
  assert.doesNotMatch(css, /\.is-compact/);
  assert.match(css, /grid-template-columns:\s*1fr/);
});

test('status is indicated by panel background without lamp imagery', () => {
  assert.doesNotMatch(js, /signal-lamp/);
  assert.doesNotMatch(css, /\.signal-lamp/);
  assert.doesNotMatch(css, /radial-gradient\(circle/);
  assert.match(css, /--light/);
});

test('status panel background keeps the state color visually dominant', () => {
  assert.match(css, /--red:\s*#ff1f1f/);
  assert.match(css, /--green:\s*#00e060/);
  assert.match(css, /var\(--light\)\s+9[0-9]%/);
  assert.match(css, /var\(--light\)\s+8[0-9]%/);
});

test('dynamic status color fills the whole viewport', () => {
  assert.match(js, /document\.documentElement\.className/);
  assert.match(js, /document\.body\.className/);
  assert.match(js, /const primaryLight = primaryStatusLight\(data\)/);
  assert.match(js, /counts\.red > 0/);
  assert.match(js, /counts\.yellow > 0/);
  assert.match(js, /status-\$\{primaryLight\}/);
  assert.doesNotMatch(css, /body\s*\{[^}]*background:\s*var\(--black\)/s);
  assert.match(css, /:root\.status-red/);
  assert.match(css, /body\.status-red/);
  assert.match(css, /:root\.status-yellow/);
  assert.match(css, /body\.status-yellow/);
  assert.match(css, /:root\.status-green/);
  assert.match(css, /body\.status-green/);
  assert.match(css, /background:\s*var\(--screen-bg\)/);
});

test('status label remains readable on yellow background', () => {
  assert.doesNotMatch(css, /\.kicker\s*\{[^}]*color:\s*color-mix\(in srgb,\s*var\(--light\)/s);
  assert.match(css, /\.kicker\s*\{[^}]*color:\s*#fffaf0/s);
  assert.match(css, /\.kicker\s*\{[^}]*text-shadow:/s);
});

test('bottom indicator clears mobile browser navigation bars', () => {
  assert.match(css, /\.board\s*\{[^}]*padding-bottom:\s*64px/s);
  assert.match(css, /\.meta-strip\s*\{[^}]*bottom:\s*max\(12px,\s*calc\(env\(safe-area-inset-bottom\)\s*\+\s*10px\)\)/s);
  assert.match(css, /\.meta-strip span\s*\{[^}]*padding:\s*6px 10px/s);
});

test('status polling does not reset the clock between ticks', async () => {
  const realDate = Date;
  const realDocument = globalThis.document;
  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  let nowMs = Date.parse('2026-06-11T01:00:00.000Z');
  const intervals = [];
  const timeouts = [];

  class FakeDate extends realDate {
    constructor(...args) {
      super(...(args.length === 0 ? [nowMs] : args));
    }

    static now() {
      return nowMs;
    }

    toLocaleTimeString() {
      return this.toISOString().slice(11, 19);
    }
  }

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.className = '';
      this.children = [];
      this.textContent = '';
      this.attributes = {};
    }

    appendChild(node) {
      this.children.push(node);
      return node;
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }

    replaceChildren(...nodes) {
      this.children = nodes;
    }

    set innerHTML(value) {
      this._innerHTML = value;
      if (this.tagName !== 'footer') return;

      const match = String(value).match(/<span data-clock>(.*?)<\/span>/s);
      if (!match) return;

      const clock = new FakeElement('span');
      clock.attributes['data-clock'] = '';
      clock.textContent = match[1];
      this.children = [clock];
    }

    get innerHTML() {
      return this._innerHTML ?? '';
    }
  }

  const appRoot = new FakeElement('main');
  const doc = {
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    querySelector(selector) {
      if (selector === '#app') return appRoot;
      if (selector === '[data-clock]') {
        return findNode(appRoot, (node) => node.attributes?.['data-clock'] !== undefined);
      }
      return null;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    }
  };

  function findNode(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children ?? []) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }

  globalThis.Date = FakeDate;
  globalThis.document = doc;
  globalThis.fetch = async () => ({
    async json() {
      return {
        generatedAt: new FakeDate(nowMs).toISOString(),
        total: 1,
        counts: { red: 0, yellow: 0, green: 1 },
        threads: [
          {
            id: 'idle-thread',
            title: 'Idle task',
            preview: '',
            cwd: '',
            light: 'green',
            status: 'idle',
            ageMs: null
          }
        ]
      };
    }
  });
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms });
    return intervals.length;
  };
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = (fn, ms) => {
    timeouts.push({ fn, ms });
    return timeouts.length;
  };
  globalThis.clearTimeout = () => {};

  try {
    await import(`../public/app.js?clock-refresh=${nowMs}`);
    await Promise.resolve();
    await Promise.resolve();

    const firstClock = doc.querySelector('[data-clock]');
    assert.equal(firstClock.textContent, '01:00:00');
    assert.equal(timeouts[0].ms, 1000);

    nowMs = Date.parse('2026-06-11T01:00:01.000Z');
    await timeouts[0].fn();
    assert.equal(doc.querySelector('[data-clock]').textContent, '01:00:01');
    assert.equal(timeouts[1].ms, 1000);

    nowMs = Date.parse('2026-06-11T01:00:10.000Z');
    await intervals.find((entry) => entry.ms === 2000).fn();
    assert.equal(doc.querySelector('[data-clock]'), firstClock);
    assert.equal(doc.querySelector('[data-clock]').textContent, '01:00:01');
  } finally {
    globalThis.Date = realDate;
    globalThis.document = realDocument;
    globalThis.fetch = realFetch;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
