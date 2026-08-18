/** 📊 Read-only inspection endpoints — "is the data any good?" */
import { Router } from 'express';
import { getDb } from '../../db/client.js';
import { messagesRepo } from '../../db/repositories/messages.repo.js';
import { syncRunsRepo } from '../../db/repositories/syncRuns.repo.js';

export const statsRouter: Router = Router();

/** GET /api/health — liveness probe for the extension's connection indicator. */
statsRouter.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'discordbot-ingest', time: new Date().toISOString() });
});

/** GET /api/stats — the numbers you actually want after a collection run. */
statsRouter.get('/stats', (_req, res) => {
  const db = getDb();

  const byKind = db
    .prepare(
      `SELECT c.kind,
              count(DISTINCT c.id) AS channels,
              count(m.id)          AS messages
       FROM channels c
       LEFT JOIN messages m ON m.channel_id = c.id
       GROUP BY c.kind ORDER BY messages DESC`,
    )
    .all();

  const topChannels = db
    .prepare(
      `SELECT c.name, c.kind, c.subnet_uid, c.message_count, c.backfill_complete
       FROM channels c WHERE c.message_count > 0
       ORDER BY c.message_count DESC LIMIT 25`,
    )
    .all();

  const byRoleCategory = db
    .prepare(
      `SELECT author_top_category AS category, count(*) AS messages
       FROM messages GROUP BY author_top_category ORDER BY messages DESC`,
    )
    .all();

  const timespan = db
    .prepare(`SELECT min(created_at) AS oldest, max(created_at) AS newest FROM messages`)
    .get();

  const roleCoverage = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM messages WHERE author_role_names IS NOT NULL) AS with_roles,
         (SELECT count(*) FROM messages) AS total`,
    )
    .get();

  res.json({
    ok: true,
    totals: messagesRepo.totals(),
    timespan,
    roleCoverage,
    byKind,
    byRoleCategory,
    topChannels,
    recentRuns: syncRunsRepo.recent(10),
  });
});

/**
 * GET /api/channels?guild=<id>
 * Full channel inventory with classification — the fastest way to check that
 * the subnet/main/excluded filter did the right thing.
 */
statsRouter.get('/channels', (req, res) => {
  const guildId = String(req.query.guild ?? '');
  const db = getDb();
  const rows = guildId
    ? db
        .prepare(
          `SELECT id, name, kind, subnet_uid, category_name, type, message_count,
                  backfill_complete, last_synced_at
           FROM channels WHERE guild_id = ? ORDER BY kind, subnet_uid, name`,
        )
        .all(guildId)
    : db
        .prepare(
          `SELECT id, guild_id, name, kind, subnet_uid, category_name, type,
                  message_count, backfill_complete, last_synced_at
           FROM channels ORDER BY kind, subnet_uid, name`,
        )
        .all();

  res.json({ ok: true, count: rows.length, channels: rows });
});

/** GET /api/search?q=…&limit=20 — FTS sanity check over collected content. */
statsRouter.get('/search', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 200);
  if (!q) {
    res.status(400).json({ ok: false, error: 'missing ?q=' });
    return;
  }

  try {
    const rows = getDb()
      .prepare(
        `SELECT m.id, m.created_at, m.content, m.author_role_names, m.author_top_category,
                u.username, u.global_name, c.name AS channel, c.kind, c.subnet_uid
         FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
         JOIN users    u ON u.id = m.author_id
         JOIN channels c ON c.id = m.channel_id
         WHERE messages_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(q, limit);
    res.json({ ok: true, count: rows.length, results: rows });
  } catch (err) {
    // FTS5 throws on malformed MATCH syntax — surface it rather than 500ing.
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});
