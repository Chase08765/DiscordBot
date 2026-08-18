/**
 * 🎛️ Popup.
 *
 * One screen, no tabs. It renders whatever the service worker reports and
 * nothing else — closing it never interrupts a run.
 *
 * The headline number comes from the SERVER, not from a counter the collector
 * accumulates. That matters: a run tally shows 0 whenever the service worker
 * has restarted, the popup was opened fresh, or an older run is still going.
 * "How many rows are in the table" is a question only the database can answer.
 */
import { MSG, RUN_STATE } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);
const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

let watching = false;

// ── Rendering ────────────────────────────────────────────────────────────────

function renderTotals(totals) {
  $('db-total').textContent = fmt(totals?.messages);
  $('db-channels').textContent = fmt(totals?.channels);
  $('db-members').textContent = fmt(totals?.members);
}

function renderStats(stats) {
  if (!stats) return;

  const state = stats.state ?? RUN_STATE.IDLE;
  const busy = state === RUN_STATE.COLLECTING || state === RUN_STATE.DISCOVERING;

  $('status-badge').textContent = state;
  $('status-badge').className = `badge badge--${state}`;
  $('run-new').textContent = fmt(stats.messagesSaved ?? 0);

  // Progress + a one-line description of what is happening right now.
  const total = stats.channelsTotal || 0;
  const done = stats.channelsDone ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('status-fill').style.width = busy ? `${pct}%` : '0%';

  if (busy && stats.currentChannel) {
    $('status-text').textContent = `${done}/${total} · #${stats.currentChannel}`;
  } else if (busy) {
    $('status-text').textContent = 'starting…';
  } else if (state === RUN_STATE.WATCHING) {
    $('status-text').textContent = 'checking for new messages on a timer';
  } else {
    $('status-text').textContent = 'Not running';
  }

  $('btn-collect').disabled = busy;
  $('btn-roles').disabled = busy;
  $('btn-discover').disabled = busy;
  $('btn-stop').disabled = !busy;

  showError(stats.error);
}

function renderWatch(watch) {
  watching = Boolean(watch?.active);
  const button = $('btn-watch');

  button.textContent = watching ? '👁️ Watching — click to stop' : '👁️ Watch for new';
  button.classList.toggle('btn--active', watching);

  if (!watching) return;

  const bits = [`${watch.sweeps ?? 0} checks`];
  if (watch.totalNew) bits.push(`${fmt(watch.totalNew)} new`);
  if (watch.lastSweepAt) bits.push(ago(watch.lastSweepAt));
  $('footer-hint').textContent = `👁️ ${bits.join(' · ')}`;

  if (watch.lastError) showError(watch.lastError);
}

function ago(timestamp) {
  const s = Math.round((Date.now() - timestamp) / 1000);
  if (s < 60) return `last check ${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `last check ${m}m ago`;
  return `last check ${Math.round(m / 60)}h ago`;
}

function showError(message) {
  const box = $('error');
  if (!message) {
    box.classList.add('error--hidden');
    return;
  }
  box.textContent = `❌ ${message}`;
  box.classList.remove('error--hidden');
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function run(message) {
  showError(null);
  $('status-text').textContent = 'starting…';
  const result = await send(message);
  if (!result?.ok) showError(result?.error);
  await refresh();
}

$('btn-collect').addEventListener('click', () => run(MSG.START));
$('btn-discover').addEventListener('click', () => run(MSG.DISCOVER));
$('btn-roles').addEventListener('click', () => run(MSG.ENRICH));
$('btn-stop').addEventListener('click', () => run(MSG.STOP));
$('btn-watch').addEventListener('click', () => run(watching ? MSG.WATCH_STOP : MSG.WATCH_START));

// ── Live updates ─────────────────────────────────────────────────────────────

async function refresh() {
  const state = await send(MSG.GET_STATE);
  if (!state?.ok) return;

  renderStats(state.stats);
  renderWatch(state.watch);
  renderTotals(state.totals);

  const online = Boolean(state.serverOnline);
  $('server-dot').className = `dot ${online ? 'dot--ok' : 'dot--err'}`;
  $('server-dot').title = online ? 'Ingest server online' : 'Ingest server offline — start it first';

  if (!online) {
    showError('Ingest server is not running. Double-click start-server.bat in the project folder.');
  }
}

// Push updates keep the run view live; the poll keeps database totals and watch
// state fresh even when nothing is broadcasting (e.g. between watch sweeps).
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.STATE_CHANGED) renderStats(message.stats);
});

refresh();
setInterval(refresh, 3000);
