/** 📊 Audit trail for collection runs. */
import { getDb } from '../client.js';

export const syncRunsRepo = {
  start(runId: string, guildId: string | null, mode: string): void {
    getDb()
      .prepare(
        `INSERT INTO sync_runs (id, guild_id, mode, status)
         VALUES (?, ?, ?, 'running')
         ON CONFLICT(id) DO UPDATE SET
           guild_id = COALESCE(excluded.guild_id, sync_runs.guild_id),
           status   = 'running'`,
      )
      .run(runId, guildId, mode);
  },

  /**
   * Called after every batch so a crashed run still leaves accurate numbers.
   *
   * Message counts accumulate, but `users_seen` cannot: the same author appears
   * in many batches, so summing per-batch counts over-reports badly. It is
   * recomputed instead as the distinct membership known for the guild, which is
   * both correct and the number you actually want to read.
   */
  addProgress(
    runId: string,
    delta: { messages?: number; skipped?: number; channels?: number },
  ): void {
    getDb()
      .prepare(
        `UPDATE sync_runs SET
           messages_ingested = messages_ingested + @messages,
           messages_skipped  = messages_skipped  + @skipped,
           channels_seen     = MAX(channels_seen, @channels),
           users_seen        = (
             SELECT count(*) FROM guild_members
             WHERE guild_id = sync_runs.guild_id
           )
         WHERE id = @runId`,
      )
      .run({
        runId,
        messages: delta.messages ?? 0,
        skipped: delta.skipped ?? 0,
        channels: delta.channels ?? 0,
      });
  },

  finish(runId: string, status: 'completed' | 'failed' | 'aborted', error?: string): void {
    getDb()
      .prepare(
        `UPDATE sync_runs SET status = ?, finished_at = datetime('now'), error = ?
         WHERE id = ?`,
      )
      .run(status, error ?? null, runId);
  },

  recent(limit = 20): unknown[] {
    return getDb().prepare(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?`).all(limit);
  },
};
