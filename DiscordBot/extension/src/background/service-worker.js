/**
 * 🧩 Service worker — the extension's control plane.
 *
 * Owns the collector instance and answers the popup. Nothing else.
 *
 * ⚠️ MV3 service workers are killed after ~30s idle. A long collection run
 * keeps this one alive because it is continuously awaiting fetches, but the run
 * does NOT survive a browser restart — that's what the resumable cursors in the
 * database are for. Restarting simply picks up where it stopped.
 */
import { MSG, RUN_STATE, EMOJI } from '../shared/constants.js';
import { getConfig } from '../shared/config.js';
import { createLogger, setLogLevel } from '../shared/logger.js';
import { Collector } from './collector.js';
import { IngestClient } from './ingest-client.js';
import { acquireToken } from './token.js';
import { ALARM_NAME, getWatchState, runSweep, startWatching, stopWatching } from './watcher.js';

const log = createLogger('worker');

/** @type {Collector | null} */
let collector = null;
let lastStats = { state: RUN_STATE.IDLE };

function onProgress(stats) {
  lastStats = stats;
  chrome.runtime.sendMessage({ type: MSG.STATE_CHANGED, stats }).catch(() => {});
}

async function startRun(mode) {
  if (lastStats.state === RUN_STATE.COLLECTING || lastStats.state === RUN_STATE.DISCOVERING) {
    return { ok: false, error: 'A run is already in progress.' };
  }

  const config = await getConfig();
  setLogLevel(config.logLevel);

  log.event(EMOJI.startup, 'info', `${mode} requested`);

  // Fail fast on an unreachable server. Without the old IndexedDB outbox there
  // is nowhere to park batches, so there is no point starting a harvest we
  // cannot store.
  const probe = new IngestClient({ serverUrl: config.serverUrl, ingestKey: config.ingestKey });
  const health = await probe.ping();
  if (!health.ok) {
    return {
      ok: false,
      error: `Ingest server not reachable at ${config.serverUrl} (${health.error}). Start it with \`npm run dev\` in server/.`,
    };
  }
  log.event(EMOJI.done, 'info', 'ingest server reachable', { url: config.serverUrl });

  const { token, guildId: detectedGuild } = await acquireToken();

  const guildId = config.guildId?.trim() || detectedGuild;
  if (!guildId) {
    return {
      ok: false,
      error:
        'No guild ID. Open the Bittensor server in Discord so the URL reads /channels/<id>/…, or set one in Settings.',
    };
  }

  collector = new Collector({ config, token, guildId, onProgress });

  // Deliberately not awaited: the popup gets its response immediately and
  // watches progress through STATE_CHANGED broadcasts.
  const task =
    mode === 'discover' ? collector.discover() : mode === 'enrich' ? collector.enrich() : collector.run();
  task.catch((err) => {
    if (err.name === 'AbortError') return;
    log.event(EMOJI.error, 'error', 'run ended with an error', { error: err.message });
    lastStats = { ...lastStats, state: RUN_STATE.ERROR, error: err.message };
    onProgress(lastStats);
  });

  return { ok: true, runId: collector.runId, guildId };
}

// ── 📬 Message router ────────────────────────────────────────────────────────

const handlers = {
  /**
   * Everything the popup renders, in one call.
   *
   * `totals` is read live from the database rather than taken from a run
   * counter — a counter reads 0 whenever the service worker restarted or the
   * popup was opened fresh, which is exactly when you most want the number.
   */
  async [MSG.GET_STATE]() {
    const config = await getConfig();
    const client = new IngestClient({ serverUrl: config.serverUrl, ingestKey: config.ingestKey });
    const watch = await getWatchState();

    const health = await client.ping();
    const guildId = config.guildId?.trim() || lastStats.guildId || watch.guildId;
    const totals = health.ok && guildId ? await client.totals(guildId) : null;

    return {
      ok: true,
      stats: lastStats,
      watch,
      totals,
      serverOnline: health.ok,
    };
  },

  [MSG.START]: () => startRun('collect'),
  [MSG.DISCOVER]: () => startRun('discover'),
  [MSG.ENRICH]: () => startRun('enrich'),

  async [MSG.STOP]() {
    if (!collector) return { ok: false, error: 'Nothing is running.' };
    collector.stop();
    return { ok: true };
  },

  /**
   * 👁️ Watch mode. Needs a guild ID, resolved the same way a run does, but no
   * collector instance — the alarm handler rebuilds everything each sweep,
   * because the service worker will not survive the gaps between them.
   */
  async [MSG.WATCH_START]() {
    const config = await getConfig();
    let guildId = config.guildId?.trim();

    if (!guildId) {
      const { guildId: detected } = await acquireToken();
      guildId = detected;
    }
    if (!guildId) {
      return {
        ok: false,
        error: 'No guild ID. Open the Bittensor server in Discord, or set one in Settings.',
      };
    }

    const result = await startWatching(guildId);
    lastStats = { ...lastStats, state: RUN_STATE.WATCHING, guildId };
    onProgress(lastStats);
    return result;
  },

  async [MSG.WATCH_STOP]() {
    const result = await stopWatching();
    lastStats = { ...lastStats, state: RUN_STATE.IDLE };
    onProgress(lastStats);
    return result;
  },

};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  Promise.resolve(handler(message.payload))
    .then(sendResponse)
    .catch((err) => {
      log.event(EMOJI.error, 'error', `handler ${message.type} failed`, { error: err.message });
      sendResponse({ ok: false, error: err.message });
    });

  return true; // async response
});

// ── ⏰ Watch alarm ───────────────────────────────────────────────────────────
//
// This is the entry point Chrome uses to wake the worker back up between
// sweeps. It must be registered at the top level — registering it inside an
// async callback would miss alarms that fire before that callback resolves.

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  // Don't let a sweep collide with a manual Collect/Enrich run.
  if (lastStats.state === RUN_STATE.COLLECTING || lastStats.state === RUN_STATE.DISCOVERING) {
    log.event(EMOJI.skipped, 'info', 'sweep skipped — a run is in progress');
    return;
  }

  getConfig()
    .then((config) => setLogLevel(config.logLevel))
    .then(() => runSweep(onProgress))
    .catch((err) => log.event(EMOJI.error, 'error', 'sweep crashed', { error: err.message }));
});

// ── 🚀 Boot ──────────────────────────────────────────────────────────────────

getConfig().then(async (config) => {
  setLogLevel(config.logLevel);
  log.event(EMOJI.startup, 'info', 'service worker ready', {
    server: config.serverUrl,
    delayMs: config.requestDelayMs,
  });

  // The worker restarts constantly under MV3. Reflect any active watch so the
  // popup doesn't show "idle" while sweeps are still scheduled.
  const watch = await getWatchState();
  if (watch.active) {
    lastStats = { ...lastStats, state: RUN_STATE.WATCHING, guildId: watch.guildId };
    log.event(EMOJI.discover, 'info', 'watch mode is active', {
      guild: watch.guildId,
      sweeps: watch.sweeps ?? 0,
      everyMinutes: config.watchIntervalMinutes,
    });
  }
});
