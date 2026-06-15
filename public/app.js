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
  renderSignal(signalItem, { ...thread, light: primaryLight });
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

function renderSignal(item, thread) {
  item.className = `signal signal-${thread.light}`;

  const label = lightText[thread.light] ?? thread.light;
  const age = thread.ageMs === null ? 'READY' : `${Math.round(thread.ageMs / 1000)}s`;
  item.innerHTML = `
    <div class="signal-copy">
      <p class="kicker">${escapeHtml(label)} · ${escapeHtml(age)}</p>
      <h1>${escapeHtml(thread.title || 'Codex task')}</h1>
      <p>${escapeHtml(thread.preview || thread.cwd || 'Codex task')}</p>
    </div>
  `;
}

function formatTime(value) {
  const date = new Date(value);
  return date.toLocaleTimeString('zh-CN', { hour12: false });
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
