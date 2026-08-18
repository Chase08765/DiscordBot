/** 📚 Channel persistence + backfill bookkeeping. */
import { getDb, prepare, bit } from '../client.js';
import type { ChannelInputT, ChannelProgressInputT } from '../../ingest/schemas.js';

/** Shape returned by `progressFor` — what the extension needs to resume. */
export interface ChannelProgressRow {
  id: string;
  name: string;
  kind: string;
  subnet_uid: number | null;
  oldest_synced_message_id: string | null;
  newest_synced_message_id: string | null;
  backfill_complete: number;
  backfill_horizon: string | null;
  message_count: number;
}

export const channelsRepo = {
  upsertMany(guildId: string, channels: ChannelInputT[]): number {
    const stmt = getDb().prepare(
      `INSERT INTO channels (id, guild_id, parent_id, category_name, name, type,
                             position, topic, nsfw, kind, subnet_uid, raw_json)
       VALUES (@id, @guild_id, @parent_id, @category_name, @name, @type,
               @position, @topic, @nsfw, @kind, @subnet_uid, @raw_json)
       ON CONFLICT(id) DO UPDATE SET
         parent_id     = excluded.parent_id,
         category_name = excluded.category_name,
         name          = excluded.name,
         type          = excluded.type,
         position      = excluded.position,
         topic         = excluded.topic,
         nsfw          = excluded.nsfw,
         kind          = excluded.kind,
         subnet_uid    = excluded.subnet_uid,
         raw_json      = excluded.raw_json`,
    );

    for (const c of channels) {
      stmt.run({
        id: c.id,
        guild_id: guildId,
        parent_id: c.parent_id ?? null,
        category_name: c.categoryName ?? null,
        name: c.name,
        type: c.type,
        position: c.position ?? 0,
        topic: c.topic ?? null,
        nsfw: bit(c.nsfw),
        kind: c.kind,
        subnet_uid: c.subnetUid ?? null,
        raw_json: JSON.stringify(c),
      });
    }
    return channels.length;
  },

  /**
   * Ensure a channel row exists before messages reference it. Messages can
   * arrive for a thread or a channel we haven't catalogued yet.
   */
  ensure(channelId: string, guildId: string): void {
    prepare(
      `INSERT INTO channels (id, guild_id, name, type, kind)
       VALUES (?, ?, '(unknown)', 0, 'other')
       ON CONFLICT(id) DO NOTHING`,
    ).run(channelId, guildId);
  },

  /**
   * Record how far a backfill has walked. `oldest` only ever moves backwards
   * and `newest` only ever moves forwards, so a re-run that starts from the top
   * cannot erase progress. Snowflakes compare correctly with a length-then-value
   * comparison, which is what the CASE expressions below do.
   */
  updateProgress(progress: ChannelProgressInputT[]): void {
    const stmt = getDb().prepare(
      `UPDATE channels SET
         oldest_synced_message_id = CASE
           WHEN @oldest IS NULL THEN oldest_synced_message_id
           WHEN oldest_synced_message_id IS NULL THEN @oldest
           WHEN length(@oldest) < length(oldest_synced_message_id) THEN @oldest
           WHEN length(@oldest) = length(oldest_synced_message_id)
                AND @oldest < oldest_synced_message_id THEN @oldest
           ELSE oldest_synced_message_id
         END,
         newest_synced_message_id = CASE
           WHEN @newest IS NULL THEN newest_synced_message_id
           WHEN newest_synced_message_id IS NULL THEN @newest
           WHEN length(@newest) > length(newest_synced_message_id) THEN @newest
           WHEN length(@newest) = length(newest_synced_message_id)
                AND @newest > newest_synced_message_id THEN @newest
           ELSE newest_synced_message_id
         END,
         backfill_complete = CASE WHEN @complete = 1 THEN 1 ELSE backfill_complete END,
         -- Only meaningful alongside a completion, and always overwritten there
         -- (including with NULL, which means "reached the true first message").
         backfill_horizon  = CASE WHEN @complete = 1 THEN @horizon ELSE backfill_horizon END,
         message_count     = (SELECT count(*) FROM messages WHERE channel_id = @id),
         last_synced_at    = datetime('now')
       WHERE id = @id`,
    );

    for (const p of progress) {
      stmt.run({
        id: p.channelId,
        oldest: p.oldestSyncedMessageId ?? null,
        newest: p.newestSyncedMessageId ?? null,
        complete: bit(p.backfillComplete),
        horizon: p.backfillHorizon ?? null,
      });
    }
  },

  /** What the extension asks for on resume: where each channel left off. */
  progressFor(guildId: string): ChannelProgressRow[] {
    return getDb()
      .prepare(
        `SELECT id, name, kind, subnet_uid, oldest_synced_message_id,
                newest_synced_message_id, backfill_complete, backfill_horizon,
                message_count
         FROM channels WHERE guild_id = ? AND kind != 'excluded'
         ORDER BY kind, subnet_uid, position`,
      )
      .all(guildId) as ChannelProgressRow[];
  },
};
