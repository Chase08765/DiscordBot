/** 💬 Message persistence, plus attachments / mentions / reactions. */
import { getDb, prepare, bit } from '../client.js';
import { env } from '../../config/env.js';
import type { MessageInputT } from '../../ingest/schemas.js';
import type { ResolvedRoles } from './users.repo.js';

// Hoisted SQL. This is the hottest path in the whole server — every one of
// these runs once per collected message (or more), so they go through the
// prepared-statement cache rather than being re-prepared per row.
const SQL_INSERT_MESSAGE = `
  INSERT INTO messages (
    id, channel_id, guild_id, author_id, content, created_at, edited_at,
    type, pinned, tts, referenced_message_id, thread_id,
    attachment_count, embed_count, reaction_count, mention_count,
    mentions_everyone, author_role_names, author_top_category, raw_json
  ) VALUES (
    @id, @channel_id, @guild_id, @author_id, @content, @created_at, @edited_at,
    @type, @pinned, @tts, @referenced_message_id, @thread_id,
    @attachment_count, @embed_count, @reaction_count, @mention_count,
    @mentions_everyone, @author_role_names, @author_top_category, @raw_json
  )
  ON CONFLICT(id) DO NOTHING`;

const SQL_INSERT_ATTACHMENT = `
  INSERT INTO attachments (id, message_id, filename, content_type, size, url, proxy_url, width, height)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`;

const SQL_INSERT_MENTION = `
  INSERT INTO message_mentions (message_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING`;

const SQL_INSERT_REACTION = `
  INSERT INTO message_reactions (message_id, emoji, count) VALUES (?, ?, ?)
  ON CONFLICT(message_id, emoji) DO UPDATE SET count = excluded.count`;

export const messagesRepo = {
  /**
   * Insert one message and its children. Returns false if the message was
   * already stored (`ON CONFLICT DO NOTHING` → zero changes), which the caller
   * counts as "skipped".
   *
   * Must be called inside a transaction — see ingest.service.
   */
  insert(msg: MessageInputT, guildId: string, roles: ResolvedRoles | null): boolean {
    const result = prepare(SQL_INSERT_MESSAGE).run({
      id: msg.id,
      channel_id: msg.channel_id,
      guild_id: guildId,
      author_id: msg.author.id,
      content: msg.content ?? '',
      created_at: msg.timestamp,
      edited_at: msg.edited_timestamp ?? null,
      type: msg.type,
      pinned: bit(msg.pinned),
      tts: bit(msg.tts),
      referenced_message_id: msg.message_reference?.message_id ?? null,
      thread_id: msg.thread?.id ?? null,
      attachment_count: msg.attachments.length,
      embed_count: msg.embeds.length,
      reaction_count: msg.reactions.reduce((sum, r) => sum + r.count, 0),
      mention_count: msg.mentions.length,
      mentions_everyone: bit(msg.mention_everyone),
      author_role_names: roles?.names.join(', ') ?? null,
      author_top_category: roles?.top ?? 'other',
      raw_json: env.ingest.storeRawJson ? JSON.stringify(msg) : null,
    });

    // Already stored — skip the children too, they were written the first time.
    if (result.changes === 0) return false;

    if (msg.attachments.length) {
      const stmt = prepare(SQL_INSERT_ATTACHMENT);
      for (const a of msg.attachments) {
        stmt.run(
          a.id,
          msg.id,
          a.filename ?? null,
          a.content_type ?? null,
          a.size ?? null,
          a.url ?? null,
          a.proxy_url ?? null,
          a.width ?? null,
          a.height ?? null,
        );
      }
    }

    if (msg.mentions.length) {
      const stmt = prepare(SQL_INSERT_MENTION);
      for (const m of msg.mentions) stmt.run(msg.id, m.id);
    }

    if (msg.reactions.length) {
      const stmt = prepare(SQL_INSERT_REACTION);
      for (const r of msg.reactions) {
        stmt.run(msg.id, r.emoji.name ?? r.emoji.id ?? '?', r.count);
      }
    }

    return true;
  },

  /**
   * Which of these message IDs do we already have?
   *
   * Lets the collector stop walking a channel the moment it reaches territory
   * it has already stored, instead of paging through history it will only
   * throw away. The saving is Discord requests, which is the expensive part —
   * this check itself is a local index lookup.
   *
   * Chunked because SQLite caps a statement at 32766 bound parameters.
   */
  known(ids: string[]): string[] {
    if (!ids.length) return [];
    const db = getDb();
    const found: string[] = [];

    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT id FROM messages WHERE id IN (${placeholders})`)
        .all(...chunk) as Array<{ id: string }>;
      for (const row of rows) found.push(row.id);
    }
    return found;
  },

  /**
   * Cheap per-guild counters for the popup's headline display.
   *
   * `members` counts guild_members — i.e. people whose ROLES we have resolved,
   * not everyone who has posted. It reads 0 until the enrichment pass runs,
   * which is the honest signal that role data is still missing.
   */
  guildTotals(guildId: string): { messages: number; members: number; channels: number } {
    const db = getDb();
    const one = (sql: string) => (db.prepare(sql).get(guildId) as { n: number }).n;
    return {
      messages: one(`SELECT count(*) AS n FROM messages WHERE guild_id = ?`),
      members: one(`SELECT count(*) AS n FROM guild_members WHERE guild_id = ?`),
      channels: one(`SELECT count(*) AS n FROM channels WHERE guild_id = ? AND message_count > 0`),
    };
  },

  totals(): { messages: number; users: number; channels: number; guilds: number } {
    const db = getDb();
    const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      messages: one(`SELECT count(*) AS n FROM messages`),
      users: one(`SELECT count(*) AS n FROM users`),
      channels: one(`SELECT count(*) AS n FROM channels`),
      guilds: one(`SELECT count(*) AS n FROM guilds`),
    };
  },
};
