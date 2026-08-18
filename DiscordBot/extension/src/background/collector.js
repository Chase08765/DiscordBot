/**
 * 🤖 The collector.
 *
 * Drives a full harvest of one guild:
 *
 *   1. 🔑 acquire the token from the Discord tab (MAIN-world bridge)
 *   2. 🏛️ fetch guild metadata + 🎭 roles + 📚 channels
 *   3. 🔍 classify channels → main / subnet 0-128 / excluded
 *   4. 📈 ask the server where each channel left off last time
 *   5. 💬 for each collectable channel:
 *        a. INCREMENTAL — pull anything newer than what we already have
 *        b. BACKFILL    — page backwards with `before` until history runs out
 *   6. 💾 stream batches to the ingest server (buffered on failure)
 *
 * Everything is resumable. Stopping mid-run and starting again picks up from
 * the last recorded cursor rather than re-reading from the top.
 */
import { CHANNEL_KIND, CHANNEL_TYPE, EMOJI, RUN_STATE } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { DiscordApi, DiscordApiError, snowflakeToDate } from './discord-api.js';
import { RateLimiter, sleep } from './rate-limiter.js';
import { classifyChannels, collectableChannels, toIngestChannel } from './channel-filter.js';
import { IngestClient } from './ingest-client.js';

const log = createLogger('collector');

/** Message types worth keeping: 0 = default, 19 = reply. Everything else is chrome. */
const CONTENT_MESSAGE_TYPES = new Set([0, 19]);

/**
 * Should this channel be walked backwards again?
 *
 * `backfillComplete` alone is ambiguous — it can mean "read every message ever"
 * or "read back to the configured date horizon". Storing the horizon that was
 * actually reached disambiguates it, so lowering `backfillSinceIso` resumes the
 * walk instead of silently skipping the channel forever.
 *
 * @param {{complete?: boolean, horizon?: string|null}|undefined} resume  server state
 * @param {string} configuredHorizon  config.backfillSinceIso ('' = no limit)
 */
export function needsBackfill(resume, configuredHorizon) {
  if (!resume?.complete) return true; // never finished, or never started
  if (!resume.horizon) return false; // reached the channel's true first message
  if (!configuredHorizon) return true; // now asking for all history
  return new Date(configuredHorizon) < new Date(resume.horizon); // asking for older
}

export class Collector {
  /**
   * @param {object} deps
   * @param {object} deps.config
   * @param {string} deps.token
   * @param {string} deps.guildId
   * @param {(patch: object) => void} deps.onProgress  called whenever stats move
   */
  constructor({ config, token, guildId, onProgress }) {
    this.config = config;
    this.guildId = guildId;
    this.onProgress = onProgress ?? (() => {});

    this.limiter = new RateLimiter({
      requestDelayMs: config.requestDelayMs,
      backoffFactor: config.rateLimitBackoffFactor,
      maxBackoffMs: config.maxBackoffMs,
    });
    this.api = new DiscordApi(token, this.limiter);
    this.ingest = new IngestClient({
      serverUrl: config.serverUrl,
      ingestKey: config.ingestKey,
    });

    this.abortController = new AbortController();
    this.runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.stats = {
      state: RUN_STATE.IDLE,
      runId: this.runId,
      guildId,
      guildName: null,
      channelsTotal: 0,
      channelsDone: 0,
      currentChannel: null,

      /** Pulled from Discord, before any filtering. */
      messagesFetched: 0,
      /** Rejected by the content filters (bots, system messages, empties). */
      messagesSkipped: 0,
      /** Already in the database — fetched but not re-sent. */
      messagesDuplicate: 0,
      /** Confirmed written as NEW rows by the server. This is the real number. */
      messagesSaved: 0,
      /** Total rows the database holds for this guild, refreshed as we go. */
      dbTotal: 0,

      requests: 0,
      throttled: 0,
      startedAt: Date.now(),
      error: null,
    };

    /** Messages waiting to be POSTed, flushed at config.ingestBatchSize. */
    this.pending = [];
    this.pendingProgress = new Map();
  }

  stop() {
    this.stats.state = RUN_STATE.STOPPING;
    this.abortController.abort();
    log.event(EMOJI.paused, 'warn', 'stop requested');
  }

  get signal() {
    return this.abortController.signal;
  }

  get aborted() {
    return this.abortController.signal.aborted;
  }

  publish(patch = {}) {
    Object.assign(this.stats, patch, {
      requests: this.limiter.stats.requests,
      throttled: this.limiter.stats.throttled,
    });
    this.onProgress({ ...this.stats });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 🔍 DISCOVERY — inspect and classify without collecting anything
  // ═══════════════════════════════════════════════════════════════════════════

  async discover() {
    this.stats.state = RUN_STATE.DISCOVERING;
    this.publish();

    log.event(EMOJI.discover, 'info', 'discovery starting', { guild: this.guildId });

    const me = await this.api.getCurrentUser({ signal: this.signal });
    log.event(EMOJI.auth, 'info', 'authenticated', {
      as: me.global_name || me.username,
      id: me.id,
    });

    const guild = await this.api.getGuild(this.guildId, { signal: this.signal });
    this.stats.guildName = guild.name;
    log.event(EMOJI.done, 'info', 'guild resolved', { name: guild.name, id: guild.id });

    const roles = await this.api.getRoles(this.guildId, { signal: this.signal });
    log.event(EMOJI.role, 'info', 'roles fetched', { count: roles.length });
    this.logRolePreview(roles);

    const rawChannels = await this.api.getChannels(this.guildId, { signal: this.signal });
    const { classified, summary } = classifyChannels(rawChannels, this.config);

    log.event(EMOJI.channel, 'info', 'channels classified', summary);
    this.logChannelReport(classified);

    // Persist the inventory so you can inspect it in SQLite, but no messages.
    await this.ingest.send({
      runId: this.runId,
      mode: 'discover',
      guild: { id: guild.id, name: guild.name, icon: guild.icon, description: guild.description },
      roles: roles.map(normaliseRole),
      channels: classified.map(toIngestChannel),
    });

    this.stats.state = RUN_STATE.IDLE;
    this.publish({ channelsTotal: collectableChannels(classified).length });

    log.event(EMOJI.done, 'info', 'discovery complete — review the list above, then Start');
    return { guild, roles, classified, summary };
  }

  /** 🎭 Print the roles that matter, so misclassification is obvious early. */
  logRolePreview(roles) {
    const interesting = roles
      .filter((r) => /mod|admin|owner|support|team|staff|contributor|dev|validator/i.test(r.name))
      .slice(0, 30);

    if (!interesting.length) {
      log.event(EMOJI.warn, 'warn', 'no obviously privileged roles found — check role names');
      return;
    }
    log.event(EMOJI.role, 'info', `notable roles (${interesting.length}):`);
    for (const role of interesting) {
      log.event(EMOJI.role, 'info', `   • ${role.name}`, { id: role.id, position: role.position });
    }
  }

  /** 📚 Print the full classification so the filter can be calibrated. */
  logChannelReport(classified) {
    const groups = {
      [CHANNEL_KIND.MAIN]: [],
      [CHANNEL_KIND.SUBNET]: [],
      [CHANNEL_KIND.OTHER]: [],
      [CHANNEL_KIND.EXCLUDED]: [],
    };
    for (const c of classified) groups[c.kind].push(c);

    groups[CHANNEL_KIND.SUBNET].sort((a, b) => a.subnetUid - b.subnetUid);

    const icons = { main: '📌', subnet: '🔢', other: '❔', excluded: '🚫' };
    for (const [kind, list] of Object.entries(groups)) {
      if (!list.length) continue;
      log.event(icons[kind], 'info', `── ${kind.toUpperCase()} (${list.length}) ──`);
      for (const c of list.slice(0, 200)) {
        const label = c.kind === CHANNEL_KIND.SUBNET ? `sn${c.subnetUid}` : '';
        log.event(icons[kind], 'info', `   ${c.name}`, {
          ...(label ? { subnet: label } : {}),
          category: c.categoryName ?? '—',
          why: c.reason,
        });
      }
      if (list.length > 200) log.info(`   … and ${list.length - 200} more`);
    }

    // Gaps in subnet coverage are the single most useful sanity check.
    const found = new Set(groups[CHANNEL_KIND.SUBNET].map((c) => c.subnetUid));
    const missing = [];
    for (let uid = this.config.subnetMin; uid <= this.config.subnetMax; uid++) {
      if (!found.has(uid)) missing.push(uid);
    }
    if (missing.length) {
      log.event(EMOJI.warn, 'warn', 'subnet numbers with no channel found', {
        count: missing.length,
        uids: missing.length > 40 ? `${missing.slice(0, 40).join(',')}…` : missing.join(','),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 🎫 ENRICHMENT — resolve member roles
  //
  // Runs separately from collection because Discord will not give us roles at
  // message-fetch time (0/4394 on the first live run). One request per user,
  // busiest authors first, so the corpus improves fastest if you stop early.
  // ═══════════════════════════════════════════════════════════════════════════

  async enrich() {
    this.stats.state = RUN_STATE.COLLECTING;
    this.stats.startedAt = Date.now();
    this.publish();

    await this.ingest.startRun(this.runId, this.guildId, 'enrich');

    try {
      // Roles must exist server-side before member role IDs can be resolved.
      const guild = await this.api.getGuild(this.guildId, { signal: this.signal });
      const roles = await this.api.getRoles(this.guildId, { signal: this.signal });
      await this.ingest.send({
        runId: this.runId,
        mode: 'enrich',
        guild: { id: guild.id, name: guild.name },
        roles: roles.map(normaliseRole),
      });

      const pending = await this.fetchEnrichmentQueue();
      if (!pending.length) {
        log.event(EMOJI.done, 'info', 'nothing to enrich — every author already has roles');
        this.stats.state = RUN_STATE.IDLE;
        this.publish();
        await this.ingest.finishRun(this.runId, 'completed');
        return;
      }

      const estimateMin = ((pending.length * this.config.requestDelayMs) / 60000).toFixed(1);
      log.event(EMOJI.role, 'info', 'enrichment starting', {
        users: pending.length,
        estimatedMinutes: estimateMin,
      });
      this.publish({ channelsTotal: pending.length, channelsDone: 0, guildName: guild.name });

      let batch = [];
      let resolved = 0;
      let unavailable = 0;

      for (const [index, entry] of pending.entries()) {
        if (this.aborted) break;

        let observation;
        try {
          const member = await this.api.getGuildMember(entry.user_id, this.guildId, {
            signal: this.signal,
            retries: 1,
          });

          if (member) {
            observation = {
              userId: entry.user_id,
              nick: member.nick ?? null,
              joinedAt: member.joined_at ?? null,
              roleIds: member.roles ?? [],
            };
            resolved++;
          } else {
            observation = { userId: entry.user_id, unavailable: true };
            unavailable++;
          }
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          // 403/404 = left the server, blocked, or privacy settings. Mark it so
          // the queue does not hand us the same user forever.
          observation = { userId: entry.user_id, unavailable: true };
          unavailable++;
          log.event(EMOJI.skipped, 'debug', 'profile unavailable', {
            user: entry.user_id,
            status: err.status ?? '?',
          });
        }

        batch.push(observation);

        if (batch.length >= 100) {
          await this.ingest.send({
            runId: this.runId,
            mode: 'enrich',
            guild: { id: this.guildId },
            members: batch,
          });
          batch = [];
        }

        if ((index + 1) % 50 === 0) {
          log.event(EMOJI.role, 'info', 'enriching', {
            done: index + 1,
            of: pending.length,
            resolved,
            unavailable,
          });
        }
        this.publish({ channelsDone: index + 1, currentChannel: `user ${index + 1}` });
      }

      if (batch.length) {
        await this.ingest.send({
          runId: this.runId,
          mode: 'enrich',
          guild: { id: this.guildId },
          members: batch,
        });
      }

      const status = this.aborted ? 'aborted' : 'completed';
      await this.ingest.finishRun(this.runId, status);
      this.stats.state = RUN_STATE.IDLE;
      this.publish({ currentChannel: null });

      log.event(EMOJI.done, 'info', `enrichment ${status}`, {
        resolved,
        unavailable,
        minutes: ((Date.now() - this.stats.startedAt) / 60000).toFixed(1),
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        await this.ingest.finishRun(this.runId, 'aborted');
        this.stats.state = RUN_STATE.IDLE;
        this.publish();
        return;
      }
      this.stats.state = RUN_STATE.ERROR;
      this.stats.error = err.message;
      this.publish();
      await this.ingest.finishRun(this.runId, 'failed', err.message);
      throw err;
    }
  }

  /** Authors with messages but no resolved roles, busiest first. */
  async fetchEnrichmentQueue() {
    const response = await fetch(
      `${this.config.serverUrl.replace(/\/+$/, '')}/api/members/pending/${this.guildId}?limit=5000`,
      { headers: this.config.ingestKey ? { 'X-Ingest-Key': this.config.ingestKey } : {} },
    );
    if (!response.ok) throw new Error(`Could not load enrichment queue: HTTP ${response.status}`);
    return (await response.json()).users ?? [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 💬 COLLECTION
  // ═══════════════════════════════════════════════════════════════════════════

  async run() {
    this.stats.state = RUN_STATE.COLLECTING;
    this.stats.startedAt = Date.now();
    this.publish();

    await this.ingest.startRun(this.runId, this.guildId, 'backfill');

    try {
      const { guild, roles, classified } = await this.prepare();
      const targets = collectableChannels(classified);

      this.publish({ channelsTotal: targets.length, guildName: guild.name });
      log.event(EMOJI.startup, 'info', 'collection starting', {
        guild: guild.name,
        channels: targets.length,
        roles: roles.length,
        run: this.runId,
      });

      // 📈 Resume state: skip finished channels, continue partial ones.
      const resume = await this.buildResumeMap();

      for (const [index, channel] of targets.entries()) {
        if (this.aborted) break;

        this.publish({
          currentChannel: channel.name,
          channelsDone: index,
        });

        await this.collectChannel(channel, resume.get(channel.id));
        await this.flushPending();

        if (!this.aborted) await sleep(this.config.channelDelayMs);
      }

      await this.flushPending();
      this.publish({ channelsDone: this.stats.channelsTotal, currentChannel: null });

      const status = this.aborted ? 'aborted' : 'completed';
      await this.ingest.finishRun(this.runId, status);

      this.stats.state = RUN_STATE.IDLE;
      this.publish();

      const minutes = ((Date.now() - this.stats.startedAt) / 60000).toFixed(1);
      log.event(this.aborted ? EMOJI.paused : EMOJI.done, 'info', `collection ${status}`, {
        saved: this.stats.messagesSaved,
        duplicates: this.stats.messagesDuplicate,
        filtered: this.stats.messagesSkipped,
        fetched: this.stats.messagesFetched,
        dbTotal: this.stats.dbTotal,
        channels: this.stats.channelsDone,
        requests: this.limiter.stats.requests,
        throttled: this.limiter.stats.throttled,
        minutes,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        await this.ingest.finishRun(this.runId, 'aborted');
        this.stats.state = RUN_STATE.IDLE;
        this.publish();
        return;
      }
      this.stats.state = RUN_STATE.ERROR;
      this.stats.error = err.message;
      this.publish();
      await this.ingest.finishRun(this.runId, 'failed', err.message);
      log.event(EMOJI.error, 'error', 'collection failed', { error: err.message });
      throw err;
    }
  }

  /** Fetch and persist guild + roles + channels before any message work. */
  async prepare() {
    const guild = await this.api.getGuild(this.guildId, { signal: this.signal });
    const roles = await this.api.getRoles(this.guildId, { signal: this.signal });
    const rawChannels = await this.api.getChannels(this.guildId, { signal: this.signal });
    const { classified, summary } = classifyChannels(rawChannels, this.config);

    log.event(EMOJI.channel, 'info', 'channel inventory', summary);

    // Roles and channels must land BEFORE messages, so the server can resolve
    // role IDs to names when it writes each message's role snapshot.
    await this.ingest.send({
      runId: this.runId,
      mode: 'backfill',
      guild: { id: guild.id, name: guild.name, icon: guild.icon, description: guild.description },
      roles: roles.map(normaliseRole),
      channels: classified.map(toIngestChannel),
    });

    return { guild, roles, classified };
  }

  /** channelId → { oldest, newest, complete } from the server. */
  async buildResumeMap() {
    const map = new Map();
    const rows = await this.ingest.getResumeState(this.guildId);
    if (!rows) {
      log.event(EMOJI.warn, 'warn', 'no resume state available — starting fresh');
      return map;
    }
    for (const row of rows) {
      map.set(row.id, {
        oldest: row.oldest_synced_message_id,
        newest: row.newest_synced_message_id,
        complete: Boolean(row.backfill_complete),
        horizon: row.backfill_horizon ?? null,
        count: row.message_count,
      });
    }
    const done = rows.filter((r) => r.backfill_complete).length;
    log.event(EMOJI.stats, 'info', 'resume state loaded', {
      channels: rows.length,
      alreadyComplete: done,
    });
    return map;
  }

  /**
   * Collect one channel: newest-first incremental pass, then a backwards
   * backfill. Both use snowflake cursors, so neither can loop forever.
   */
  async collectChannel(channel, resume) {
    const kindLabel =
      channel.kind === CHANNEL_KIND.SUBNET ? `subnet ${channel.subnetUid}` : channel.kind;

    log.event(EMOJI.channel, 'info', `▶ ${channel.name}`, {
      kind: kindLabel,
      known: resume?.count ?? 0,
      backfilled: resume?.complete ? 'yes' : 'no',
    });

    let collected = 0;
    let oldestSeen = resume?.oldest ?? null;
    let newestSeen = resume?.newest ?? null;
    let backfillComplete = resume?.complete ?? false;
    let horizon = resume?.horizon ?? null;

    try {
      // ── a. INCREMENTAL: messages newer than what we already have ──────────
      if (resume?.newest) {
        const fresh = await this.pageForward(channel, resume.newest);
        collected += fresh.count;
        if (fresh.newest) newestSeen = fresh.newest;
      }

      // ── b. BACKFILL: walk backwards from the oldest we know ───────────────
      if (needsBackfill(resume, this.config.backfillSinceIso)) {
        const back = await this.pageBackward(channel, resume?.oldest ?? null);
        collected += back.count;
        if (back.oldest) oldestSeen = back.oldest;
        if (!newestSeen && back.newest) newestSeen = back.newest;
        backfillComplete = back.reachedStart;
        horizon = back.horizon;
      } else {
        log.event(EMOJI.skipped, 'debug', 'backfill already complete', {
          channel: channel.name,
          horizon: horizon ?? 'start of channel',
        });
      }

      this.pendingProgress.set(channel.id, {
        channelId: channel.id,
        oldestSyncedMessageId: oldestSeen,
        newestSyncedMessageId: newestSeen,
        backfillComplete,
        backfillHorizon: horizon,
      });

      log.event(EMOJI.done, 'info', `✔ ${channel.name}`, {
        new: collected,
        dbTotal: this.stats.dbTotal,
        complete: backfillComplete,
        horizon: horizon ?? '—',
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;

      if (err instanceof DiscordApiError && (err.status === 403 || err.status === 404)) {
        // Very common and completely expected: locked or gated channels.
        log.event(EMOJI.skipped, 'warn', `no access to ${channel.name}`, { status: err.status });
        return;
      }
      log.event(EMOJI.error, 'error', `failed on ${channel.name}`, { error: err.message });
    }
  }

  /** Page NEWER than `afterId`. Discord returns these newest-first too. */
  async pageForward(channel, afterId) {
    let cursor = afterId;
    let count = 0;
    let newest = null;

    for (;;) {
      if (this.aborted) break;

      const page = await this.api.getMessages(
        channel.id,
        { after: cursor, limit: this.config.discordPageSize },
        { signal: this.signal },
      );
      if (!page.length) break;

      // `after` returns oldest-first-ish; sort so cursor maths is unambiguous.
      const sorted = [...page].sort((a, b) => compareSnowflake(a.id, b.id));
      const newestInPage = sorted[sorted.length - 1].id;
      if (!newest || compareSnowflake(newestInPage, newest) > 0) newest = newestInPage;

      const outcome = await this.acceptMessages(page, channel);
      count += outcome.kept;
      cursor = newestInPage;

      log.event(EMOJI.fetched, 'debug', 'incremental page', {
        channel: channel.name,
        got: page.length,
        new: outcome.kept,
        dup: outcome.duplicates,
      });

      if (page.length < this.config.discordPageSize) break;
    }

    if (count) {
      log.event(EMOJI.fetched, 'info', 'caught up on new messages', {
        channel: channel.name,
        count,
      });
    }
    return { count, newest };
  }

  /**
   * Page OLDER than `beforeId` (or from the very newest if null) until history
   * is exhausted or a stop condition fires.
   */
  async pageBackward(channel, beforeId) {
    const sinceDate = this.config.backfillSinceIso ? new Date(this.config.backfillSinceIso) : null;
    const maxMessages = this.config.maxMessagesPerChannel || Infinity;

    let cursor = beforeId;
    let count = 0;
    let oldest = beforeId;
    let newest = null;
    let pages = 0;
    let reachedStart = false;
    /**
     * Consecutive pages where every message was already stored. Three in a row
     * means we have walked back into territory a previous run already covered,
     * so there is nothing left to gain from paging further. Three rather than
     * one, so a small overlap at a resume boundary doesn't stop us early.
     */
    let knownPageStreak = 0;
    /** Set only when we stop because of the date cut-off, never when we hit the
     *  true beginning of the channel. NULL therefore means "read everything". */
    let stoppedAtHorizon = null;

    for (;;) {
      if (this.aborted) break;
      if (count >= maxMessages) {
        log.event(EMOJI.skipped, 'info', 'per-channel cap reached', {
          channel: channel.name,
          cap: maxMessages,
        });
        break;
      }

      const page = await this.api.getMessages(
        channel.id,
        { before: cursor, limit: this.config.discordPageSize },
        { signal: this.signal },
      );
      pages++;

      if (!page.length) {
        // An empty page while walking backwards means we hit the beginning of
        // the channel. This is the ONLY way backfill_complete gets set.
        reachedStart = true;
        break;
      }

      // Page is newest-first, so the last element is the oldest.
      const oldestInPage = page[page.length - 1].id;
      const newestInPage = page[0].id;
      if (!newest) newest = newestInPage;

      // ⏰ Date cut-off: stop once we walk past the configured horizon.
      if (sinceDate && snowflakeToDate(oldestInPage) < sinceDate) {
        const inRange = page.filter((m) => new Date(m.timestamp) >= sinceDate);
        const outcome = await this.acceptMessages(inRange, channel);
        count += outcome.kept;
        oldest = inRange.length ? inRange[inRange.length - 1].id : oldestInPage;
        log.event(EMOJI.clock, 'info', 'reached date horizon', {
          channel: channel.name,
          since: this.config.backfillSinceIso,
          new: outcome.kept,
          dup: outcome.duplicates,
        });
        // Complete as far as THIS configuration goes. The horizon is recorded
        // so a later, earlier horizon resumes rather than skipping.
        reachedStart = true;
        stoppedAtHorizon = this.config.backfillSinceIso;
        break;
      }

      const outcome = await this.acceptMessages(page, channel);
      count += outcome.kept;
      oldest = oldestInPage;
      cursor = oldestInPage;

      // ♻️ Already-stored territory: stop rather than pay Discord requests for
      // messages we will only discard.
      if (outcome.candidates > 0 && outcome.duplicates === outcome.candidates) {
        knownPageStreak++;
        if (knownPageStreak >= 3) {
          log.event(EMOJI.skipped, 'info', 'reached already-collected messages', {
            channel: channel.name,
            pagesSkipped: knownPageStreak,
          });
          // NOT reachedStart: we stopped because of what we already hold, not
          // because the channel ran out. Leaving backfill_complete alone means
          // a later run will still walk further back if it needs to.
          break;
        }
      } else {
        knownPageStreak = 0;
      }

      // Checkpoint the cursor every page. Without this, stopping mid-backfill
      // of a busy channel loses the position and the next run re-walks history
      // from the top — correct, thanks to server-side dedup, but thousands of
      // wasted API calls.
      this.pendingProgress.set(channel.id, {
        channelId: channel.id,
        oldestSyncedMessageId: oldest,
        newestSyncedMessageId: newest,
        backfillComplete: false,
      });

      if (pages % 10 === 0) {
        log.event(EMOJI.fetched, 'info', 'backfilling', {
          channel: channel.name,
          pages,
          messages: count,
          at: snowflakeToDate(oldestInPage).toISOString().slice(0, 10),
        });
      }

      // A short page means there is nothing older left.
      if (page.length < this.config.discordPageSize) {
        reachedStart = true;
        break;
      }

      await this.flushPendingIfFull();
    }

    return { count, oldest, newest, reachedStart, horizon: stoppedAtHorizon };
  }

  /**
   * Apply content filters, drop anything already stored, queue the rest.
   *
   * @returns {Promise<{kept: number, duplicates: number, candidates: number}>}
   *   `candidates` is how many survived the content filters — so
   *   `duplicates === candidates` means this whole page is already in the
   *   database, which tells the caller it has reached known territory.
   */
  async acceptMessages(messages, channel) {
    const candidates = [];

    for (const msg of messages) {
      this.stats.messagesFetched++;

      if (this.config.skipBotMessages && msg.author?.bot) {
        this.stats.messagesSkipped++;
        continue;
      }
      if (this.config.skipSystemMessages && !CONTENT_MESSAGE_TYPES.has(msg.type)) {
        this.stats.messagesSkipped++;
        continue;
      }
      // Empty text with no attachment carries nothing for a Q&A corpus.
      if (!msg.content?.trim() && !msg.attachments?.length && !msg.embeds?.length) {
        this.stats.messagesSkipped++;
        continue;
      }

      candidates.push(msg);
    }

    // ♻️ Ask the database what it already has. One local round trip per page,
    // far cheaper than re-sending — and it tells us when to stop paging.
    const known = await this.ingest.known(candidates.map((m) => m.id));

    let kept = 0;
    for (const msg of candidates) {
      if (known.has(msg.id)) {
        this.stats.messagesDuplicate++;
        continue;
      }
      // `guild_id` is absent on messages fetched via the channel endpoint;
      // the server needs it, so stamp it on here.
      msg.guild_id = this.guildId;
      this.pending.push(msg);
      kept++;
    }

    this.publish();
    return { kept, duplicates: known.size, candidates: candidates.length };
  }

  async flushPendingIfFull() {
    if (this.pending.length >= this.config.ingestBatchSize) await this.flushPending();
  }

  /** 💾 Ship whatever is queued. */
  async flushPending() {
    if (!this.pending.length && !this.pendingProgress.size) return;

    const messages = this.pending;
    const progress = [...this.pendingProgress.values()];
    this.pending = [];
    this.pendingProgress.clear();

    // Split oversized queues so we never exceed the server's batch limit.
    const chunkSize = this.config.ingestBatchSize;
    for (let i = 0; i < messages.length; i += chunkSize) {
      const chunk = messages.slice(i, i + chunkSize);
      const isLast = i + chunkSize >= messages.length;
      const result = await this.ingest.send({
        runId: this.runId,
        mode: 'backfill',
        guild: { id: this.guildId },
        messages: chunk,
        ...(isLast && progress.length ? { channelProgress: progress } : {}),
      });

      // Count what the server confirms it WROTE, not what we sent. The two
      // differ whenever a message slipped past the known-check — a race with a
      // concurrent run, or an ID the check missed.
      this.stats.messagesSaved += result?.messagesInserted ?? 0;
      this.stats.messagesDuplicate += result?.messagesSkipped ?? 0;
    }

    // Progress-only batch when there were no messages to attach it to.
    if (!messages.length && progress.length) {
      await this.ingest.send({
        runId: this.runId,
        mode: 'backfill',
        guild: { id: this.guildId },
        channelProgress: progress,
      });
    }

    // Refresh the database total so the popup shows real stored counts, not a
    // running tally that resets every time the popup reopens.
    const totals = await this.ingest.totals(this.guildId);
    if (totals) this.stats.dbTotal = totals.messages;

    this.publish();
  }
}

/** Discord roles come back with fields we don't need; keep it tight. */
function normaliseRole(role) {
  return {
    id: role.id,
    name: role.name,
    color: role.color ?? 0,
    position: role.position ?? 0,
    hoist: Boolean(role.hoist),
    managed: Boolean(role.managed),
    mentionable: Boolean(role.mentionable),
    permissions: role.permissions != null ? String(role.permissions) : null,
  };
}

/**
 * Compare two snowflakes as numbers without losing precision.
 * Longer string = larger value; same length = lexicographic works.
 */
export function compareSnowflake(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
