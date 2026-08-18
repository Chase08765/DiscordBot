/** 📥 Ingest endpoints — everything the extension POSTs lands here. */
import { Router } from 'express';
import { env } from '../../config/env.js';
import { createLogger, EMOJI } from '../../core/logger.js';
import { requireIngestKey } from '../middleware.js';
import { ingestBatch } from '../../ingest/ingest.service.js';
import { IngestBatch, SyncRunFinish, SyncRunStart } from '../../ingest/schemas.js';
import { channelsRepo } from '../../db/repositories/channels.repo.js';
import { syncRunsRepo } from '../../db/repositories/syncRuns.repo.js';
import { usersRepo } from '../../db/repositories/users.repo.js';
import { messagesRepo } from '../../db/repositories/messages.repo.js';
import { z } from 'zod';

const log = createLogger('ingest');
export const ingestRouter: Router = Router();

ingestRouter.use(requireIngestKey);

/**
 * POST /api/ingest
 * Accepts a partial batch: any mix of guild / roles / channels / messages /
 * progress. Returns per-batch counts so the extension can show live progress.
 */
ingestRouter.post('/ingest', (req, res) => {
  const parsed = IngestBatch.safeParse(req.body);

  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    log.warn('rejected malformed batch', { issues: issues.length, first: issues[0] });
    res.status(400).json({ ok: false, error: 'invalid batch', issues });
    return;
  }

  const batch = parsed.data;

  if ((batch.messages?.length ?? 0) > env.ingest.maxBatchMessages) {
    res.status(413).json({
      ok: false,
      error: `batch too large: ${batch.messages?.length} messages (max ${env.ingest.maxBatchMessages})`,
    });
    return;
  }

  const result = ingestBatch(batch);
  res.json({ ok: true, result });
});

/** POST /api/run/start — open a sync-run audit record. */
ingestRouter.post('/run/start', (req, res) => {
  const parsed = SyncRunStart.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'invalid payload' });
    return;
  }
  syncRunsRepo.start(parsed.data.runId, parsed.data.guildId ?? null, parsed.data.mode);
  log.event(EMOJI.startup, 'info', 'run started', {
    run: parsed.data.runId,
    mode: parsed.data.mode,
    guild: parsed.data.guildId,
  });
  res.json({ ok: true });
});

/** POST /api/run/finish — close it out. */
ingestRouter.post('/run/finish', (req, res) => {
  const parsed = SyncRunFinish.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'invalid payload' });
    return;
  }
  syncRunsRepo.finish(parsed.data.runId, parsed.data.status, parsed.data.error);
  const emoji = parsed.data.status === 'completed' ? EMOJI.done : '⚠️ ';
  log.event(emoji, 'info', 'run finished', {
    run: parsed.data.runId,
    status: parsed.data.status,
    error: parsed.data.error,
  });
  res.json({ ok: true });
});

/**
 * GET /api/resume/:guildId
 * The extension calls this before a run so it can skip channels that are
 * already fully backfilled and resume the rest from where they stopped.
 */
ingestRouter.get('/resume/:guildId', (req, res) => {
  const guildId = req.params.guildId;
  if (!/^\d{5,25}$/.test(guildId)) {
    res.status(400).json({ ok: false, error: 'invalid guild id' });
    return;
  }
  const channels = channelsRepo.progressFor(guildId);
  log.event(EMOJI.discover, 'info', 'resume state served', {
    guild: guildId,
    channels: channels.length,
  });
  res.json({ ok: true, channels });
});

/**
 * POST /api/messages/known  { ids: [...] }
 * Returns the subset already stored, so the collector can stop paging a channel
 * as soon as it reaches messages it already has.
 */
const KnownRequest = z.object({ ids: z.array(z.string().regex(/^\d{5,25}$/)).max(2000) });

ingestRouter.post('/messages/known', (req, res) => {
  const parsed = KnownRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'expected { ids: string[] } (max 2000)' });
    return;
  }
  const known = messagesRepo.known(parsed.data.ids);
  res.json({ ok: true, known, count: known.length, of: parsed.data.ids.length });
});

/** GET /api/totals/:guildId — cheap counters for the live progress display. */
ingestRouter.get('/totals/:guildId', (req, res) => {
  const guildId = req.params.guildId;
  if (!/^\d{5,25}$/.test(guildId)) {
    res.status(400).json({ ok: false, error: 'invalid guild id' });
    return;
  }
  res.json({ ok: true, totals: messagesRepo.guildTotals(guildId) });
});

/**
 * GET /api/members/pending/:guildId?limit=500
 * Authors who have posted but whose roles were never resolved, busiest first.
 * Drives the enrichment pass — see the note in schemas.ts on why roles cannot
 * be collected alongside messages.
 */
ingestRouter.get('/members/pending/:guildId', (req, res) => {
  const guildId = req.params.guildId;
  if (!/^\d{5,25}$/.test(guildId)) {
    res.status(400).json({ ok: false, error: 'invalid guild id' });
    return;
  }
  const limit = Math.min(Number(req.query.limit ?? 500) || 500, 5000);
  const pending = usersRepo.pendingEnrichment(guildId, limit);

  log.event(EMOJI.role, 'info', 'enrichment queue served', {
    guild: guildId,
    pending: pending.length,
  });
  res.json({ ok: true, count: pending.length, users: pending });
});
