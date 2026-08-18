/**
 * 👁️ Live watch mode.
 *
 * Repeatedly sweeps every collectable channel for messages newer than the last
 * one we stored, and ingests them. This is the "keep the database current"
 * mode, as opposed to Collect which walks history backwards.
 *
 * ── Why chrome.alarms and not setInterval ───────────────────────────────────
 * MV3 kills an idle service worker after ~30s. A sweep keeps it alive (it is
 * continuously awaiting fetches), but the pause between sweeps would not — a
 * `setInterval` would simply never fire again once the worker died.
 * `chrome.alarms` is the one timer that survives, waking the worker back up.
 *
 * Consequently the watcher holds NO in-memory state between sweeps. Everything
 * it needs — whether it is running, which guild, when it last swept — lives in
 * chrome.storage, and the Discord token is re-acquired on each wake.
 */
import { EMOJI, RUN_STATE } from '../shared/constants.js';
import { getConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { DiscordApi } from './discord-api.js';
import { RateLimiter } from './rate-limiter.js';
import { IngestClient } from './ingest-client.js';
import { classifyChannels, collectableChannels, toIngestChannel } from './channel-filter.js';
import { acquireToken } from './token.js';

const log = createLogger('watch');

export const ALARM_NAME = 'btcollector-watch';
const STATE_KEY = 'btcollector.watch';

/** Message types worth keeping: 0 = default, 19 = reply. */
const CONTENT_MESSAGE_TYPES = new Set([0, 19]);

// ── State (survives the worker being killed) ─────────────────────────────────

export async function getWatchState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return stored[STATE_KEY] ?? { active: false };
}

async function setWatchState(patch) {
  const current = await getWatchState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export async function startWatching(guildId) {
  const config = await getConfig();

  await setWatchState({
    active: true,
    guildId,
    startedAt: Date.now(),
    sweeps: 0,
    totalNew: 0,
    lastSweepAt: null,
    lastError: null,
  });

  // periodInMinutes is the recurring cadence; delayInMinutes: 0 fires one now.
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0,
    periodInMinutes: config.watchIntervalMinutes,
  });

  log.event(EMOJI.startup, 'info', 'watch mode started', {
    guild: guildId,
    everyMinutes: config.watchIntervalMinutes,
  });
  return { ok: true };
}

export async function stopWatching() {
  await chrome.alarms.clear(ALARM_NAME);
  const state = await setWatchState({ active: false });

  log.event(EMOJI.paused, 'info', 'watch mode stopped', {
    sweeps: state.sweeps,
    totalNew: state.totalNew,
  });
  return { ok: true };
}

// ── The sweep ────────────────────────────────────────────────────────────────

/**
 * One pass over every collectable channel, pulling anything newer than the
 * stored cursor. Called by the alarm handler.
 *
 * @param {(patch: object) => void} onProgress
 */
export async function runSweep(onProgress = () => {}) {
  const state = await getWatchState();
  if (!state.active) return;

  const config = await getConfig();
  const runId = `watch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const limiter = new RateLimiter({
    requestDelayMs: config.requestDelayMs,
    backoffFactor: config.rateLimitBackoffFactor,
    maxBackoffMs: config.maxBackoffMs,
  });
  const ingest = new IngestClient({
    serverUrl: config.serverUrl,
    ingestKey: config.ingestKey,
  });

  // Fail quietly and retry next sweep rather than tearing down watch mode —
  // the server restarting shouldn't end a watch you set up hours ago.
  const health = await ingest.ping();
  if (!health.ok) {
    log.event(EMOJI.warn, 'warn', 'sweep skipped, server unreachable', { error: health.error });
    await setWatchState({ lastError: `server unreachable: ${health.error}` });
    return;
  }

  let token;
  try {
    ({ token } = await acquireToken());
  } catch (err) {
    log.event(EMOJI.warn, 'warn', 'sweep skipped, no Discord token', { error: err.message });
    await setWatchState({ lastError: err.message });
    return;
  }

  const api = new DiscordApi(token, limiter);
  const guildId = state.guildId;

  log.event(EMOJI.discover, 'info', `sweep #${(state.sweeps ?? 0) + 1} starting`);
  onProgress({ state: RUN_STATE.COLLECTING, currentChannel: 'sweeping…' });

  let newMessages = 0;
  let channelsWithNews = 0;

  try {
    // Refresh the channel list every sweep — new subnets appear, channels get
    // renamed, and a watcher that never notices is not much of a watcher.
    const rawChannels = await api.getChannels(guildId, {});
    const { classified } = classifyChannels(rawChannels, config);
    await ingest.send({
      runId,
      mode: 'incremental',
      guild: { id: guildId },
      channels: classified.map(toIngestChannel),
    });

    const resume = await ingest.getResumeState(guildId);
    const cursors = new Map((resume ?? []).map((r) => [r.id, r.newest_synced_message_id]));
    const targets = collectableChannels(classified);

    onProgress({ channelsTotal: targets.length, channelsDone: 0 });

    for (const [index, channel] of targets.entries()) {
      const after = cursors.get(channel.id);
      // No cursor means this channel was never collected. Watch mode is for
      // staying current, not for backfilling — leave it to Collect.
      if (!after) continue;

      onProgress({ channelsDone: index, currentChannel: channel.name });

      try {
        const fresh = await pullNew(api, ingest, channel, after, guildId, runId, config);
        if (fresh > 0) {
          newMessages += fresh;
          channelsWithNews++;
          log.event(EMOJI.saved, 'info', `📨 ${fresh} new in #${channel.name}`);
        }
      } catch (err) {
        if (err.status === 403 || err.status === 404) continue; // no access
        log.event(EMOJI.warn, 'warn', `sweep failed on #${channel.name}`, { error: err.message });
      }
    }

    const totals = await ingest.totals(guildId);

    await setWatchState({
      sweeps: (state.sweeps ?? 0) + 1,
      totalNew: (state.totalNew ?? 0) + newMessages,
      lastSweepAt: Date.now(),
      lastError: null,
    });

    log.event(newMessages ? EMOJI.done : EMOJI.skipped, 'info', 'sweep complete', {
      new: newMessages,
      channels: channelsWithNews,
      dbTotal: totals?.messages ?? '?',
      nextInMinutes: config.watchIntervalMinutes,
    });

    onProgress({
      state: RUN_STATE.WATCHING,
      currentChannel: null,
      messagesSaved: newMessages,
      dbTotal: totals?.messages ?? 0,
      channelsDone: targets.length,
    });
  } catch (err) {
    log.event(EMOJI.error, 'error', 'sweep failed', { error: err.message });
    await setWatchState({ lastError: err.message });
    onProgress({ state: RUN_STATE.WATCHING, error: err.message });
  }
}

/** Pull everything newer than `after` in one channel. Returns how many saved. */
async function pullNew(api, ingest, channel, after, guildId, runId, config) {
  let cursor = after;
  let saved = 0;
  let newest = after;

  for (;;) {
    const page = await api.getMessages(channel.id, { after: cursor, limit: 100 }, {});
    if (!page.length) break;

    // `after` returns messages ascending-ish; sort so the cursor is unambiguous.
    const sorted = [...page].sort((a, b) =>
      a.id.length !== b.id.length ? a.id.length - b.id.length : a.id < b.id ? -1 : 1,
    );
    newest = sorted[sorted.length - 1].id;

    const candidates = sorted.filter((msg) => {
      if (config.skipBotMessages && msg.author?.bot) return false;
      if (config.skipSystemMessages && !CONTENT_MESSAGE_TYPES.has(msg.type)) return false;
      if (!msg.content?.trim() && !msg.attachments?.length && !msg.embeds?.length) return false;
      return true;
    });

    // ♻️ Never re-store. Cheap insurance against overlapping sweeps.
    const known = await ingest.known(candidates.map((m) => m.id));
    const fresh = candidates.filter((m) => !known.has(m.id));
    for (const msg of fresh) msg.guild_id = guildId;

    if (fresh.length) {
      const result = await ingest.send({
        runId,
        mode: 'incremental',
        guild: { id: guildId },
        messages: fresh,
      });
      saved += result?.messagesInserted ?? 0;
    }

    cursor = newest;
    if (page.length < 100) break;
  }

  // Advance the cursor even when everything was filtered out, so the next sweep
  // doesn't re-examine the same messages forever.
  if (newest !== after) {
    await ingest.send({
      runId,
      mode: 'incremental',
      guild: { id: guildId },
      channelProgress: [{ channelId: channel.id, newestSyncedMessageId: newest }],
    });
  }

  return saved;
}
