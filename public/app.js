const app = document.querySelector('#app');
const lightText = {
  red: '正在跑',
  yellow: '将要跑完',
  green: '已跑完'
};
let board;
let signalItem;
let redCount;
let yellowCount;
let greenCount;
let clockElement;
let clockTimer;
let signalState;
let signalTimer;

load();
setInterval(load, 2000);

async function load() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const data = await response.json();
    render(data);
  } catch (error) {
    render({
      generatedAt: new Date().toISOString(),
      total: 1,
      counts: { red: 0, yellow: 1, green: 0 },
      threads: [
        {
          id: 'network-error',
          title: '连接失败',
          preview: error.message,
          cwd: '',
          light: 'yellow',
          status: 'error',
          ageMs: null
        }
      ]
    });
  }
}

function render(data) {
  const primaryLight = primaryStatusLight(data);
  document.documentElement.className = `status-${primaryLight}`;
  document.body.className = `status-${primaryLight}`;
  ensureBoard();

  const thread = data.threads[0] ?? {
    title: 'Codex task',
    preview: '',
    cwd: '',
    ageMs: null
  };
  const previousSignalHtml = signalItem?.innerHTML;
  const previousSignalClassName = signalItem?.className;
  updateSignalState({ ...thread, light: primaryLight });
  if (shouldRenderSignal(previousSignalHtml, previousSignalClassName)) {
    renderSignal(signalItem);
  }
  syncSignalTimer();
  redCount.textContent = `RED ${data.counts.red}`;
  yellowCount.textContent = `YELLOW ${data.counts.yellow}`;
  greenCount.textContent = `GREEN ${data.counts.green}`;
}

function ensureBoard() {
  if (board) return;

  board = document.createElement('section');
  board.className = 'board';
  signalItem = document.createElement('article');
  const meta = document.createElement('footer');
  meta.className = 'meta-strip';

  redCount = document.createElement('span');
  yellowCount = document.createElement('span');
  greenCount = document.createElement('span');
  clockElement = document.createElement('span');
  clockElement.setAttribute('data-clock', '');

  meta.appendChild(redCount);
  meta.appendChild(yellowCount);
  meta.appendChild(greenCount);
  meta.appendChild(clockElement);
  board.appendChild(signalItem);
  board.appendChild(meta);
  app.replaceChildren(board);
  updateClock();
  startClock();
}

function primaryStatusLight(data) {
  const counts = data.counts ?? {};
  if (counts.red > 0) return 'red';
  if (counts.yellow > 0) return 'yellow';
  return 'green';
}

function updateSignalState(thread) {
  const now = Date.now();
  const wasRed = signalState?.light === 'red';
  const incomingAgeMs = Number.isFinite(thread.ageMs) ? thread.ageMs : null;
  const startedAtMs = thread.light === 'red' ? (wasRed ? signalState.startedAtMs : now) : null;
  const ageMs =
    thread.light === 'red'
      ? wasRed
        ? currentSignalAgeMs(now)
        : 0
      : incomingAgeMs;
  const displayAgeMs =
    thread.light === 'red' ? (wasRed ? signalState.displayAgeMs ?? ageMs : 0) : ageMs;

  signalState = {
    ...thread,
    baseAgeMs: ageMs,
    baseAtMs: now,
    displayAgeMs,
    startedAtMs
  };
}

function currentSignalAgeMs(now = Date.now()) {
  if (!signalState || signalState.baseAgeMs === null) return null;
  return Math.max(0, signalState.baseAgeMs + now - signalState.baseAtMs);
}

function shouldRenderSignal(previousHtml, previousClassName) {
  if (!signalState) return false;
  if (signalState.light !== 'red') return true;
  if (previousClassName !== `signal signal-${signalState.light}`) return true;
  return !previousHtml;
}

function renderSignal(item) {
  const thread = signalState;
  if (!thread || !item) return;

  item.className = `signal signal-${thread.light}`;

  const label = lightText[thread.light] ?? thread.light;
  const ageMs = thread.displayAgeMs ?? currentSignalAgeMs();
  const age = ageMs === null ? 'READY' : formatDuration(ageMs);
  item.innerHTML = `
    <div class="signal-copy">
      <p class="kicker">${escapeHtml(label)} · ${escapeHtml(age)}</p>
      <h1>${escapeHtml(thread.title || 'Codex task')}</h1>
      <p>${escapeHtml(thread.preview || thread.cwd || 'Codex task')}</p>
    </div>
  `;
}

function formatDuration(valueMs) {
  const totalSeconds = Math.floor(valueMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatTime(value) {
  const date = new Date(value);
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function syncSignalTimer() {
  if (signalState?.light === 'red') {
    startSignalTimer();
    return;
  }

  stopSignalTimer();
}

function startSignalTimer() {
  if (signalTimer) return;
  signalTimer = setTimeout(tickSignal, nextSignalTickDelayMs());
}

function stopSignalTimer() {
  if (!signalTimer) return;
  clearTimeout(signalTimer);
  signalTimer = undefined;
}

function tickSignal() {
  signalTimer = undefined;
  if (signalState?.light !== 'red') return;

  signalState.displayAgeMs = currentSignalAgeMs();
  renderSignal(signalItem);
  startSignalTimer();
}

function nextSignalTickDelayMs(now = Date.now()) {
  const startedAtMs = signalState?.startedAtMs ?? now;
  const elapsedMs = Math.max(0, now - startedAtMs);
  const remainderMs = elapsedMs % 1000;
  return remainderMs === 0 ? 1000 : 1000 - remainderMs;
}

function updateClock() {
  const clock = clockElement ?? document.querySelector('[data-clock]');
  if (clock) clock.textContent = formatTime(new Date());
}

function startClock() {
  if (clockTimer) return;
  clockTimer = setTimeout(tickClock, 1000);
}

function tickClock() {
  clockTimer = undefined;
  updateClock();
  startClock();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
