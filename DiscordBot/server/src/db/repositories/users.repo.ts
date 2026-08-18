/** 👤 User + guild-membership + role-assignment persistence. */
import { prepare, bit } from '../client.js';
import { topCategory, type RoleCategory } from '../roleCategory.js';
import type { RoleLookupEntry } from './roles.repo.js';

export interface UserLike {
  id: string;
  username?: string | null;
  global_name?: string | null;
  discriminator?: string | null;
  avatar?: string | null;
  bot?: boolean | null;
  system?: boolean | null;
}

/** Result of resolving a member's role IDs against the guild's role table. */
export interface ResolvedRoles {
  names: string[];
  top: RoleCategory;
}

// Hoisted SQL — these run once per message, same as messages.repo.
const SQL_UPSERT_USER = `
  INSERT INTO users (id, username, global_name, discriminator, avatar, is_bot, is_system)
  VALUES (@id, @username, @global_name, @discriminator, @avatar, @is_bot, @is_system)
  ON CONFLICT(id) DO UPDATE SET
    username      = COALESCE(excluded.username, users.username),
    global_name   = COALESCE(excluded.global_name, users.global_name),
    discriminator = COALESCE(excluded.discriminator, users.discriminator),
    avatar        = COALESCE(excluded.avatar, users.avatar),
    is_bot        = excluded.is_bot,
    last_seen_at  = datetime('now')`;

const SQL_INSERT_MEMBER_ROLE = `
  INSERT INTO member_roles (guild_id, user_id, role_id)
  VALUES (?, ?, ?) ON CONFLICT DO NOTHING`;

const SQL_UPSERT_MEMBER = `
  INSERT INTO guild_members (guild_id, user_id, nick, joined_at, role_names, top_category)
  VALUES (@guild_id, @user_id, @nick, @joined_at, @role_names, @top_category)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    nick             = COALESCE(excluded.nick, guild_members.nick),
    joined_at        = COALESCE(excluded.joined_at, guild_members.joined_at),
    role_names       = COALESCE(NULLIF(excluded.role_names, ''), guild_members.role_names),
    top_category     = CASE WHEN excluded.role_names IS NOT NULL AND excluded.role_names != ''
                            THEN excluded.top_category ELSE guild_members.top_category END,
    last_observed_at = datetime('now')`;

const SQL_GET_MEMBER = `
  SELECT role_names, top_category FROM guild_members WHERE guild_id = ? AND user_id = ?`;

/**
 * Authors who have posted but whose roles we have never resolved.
 *
 * Ordered by message count so the enrichment pass improves the corpus fastest:
 * the person with 400 messages is worth resolving before the one with 1.
 */
const SQL_PENDING_ENRICHMENT = `
  SELECT m.author_id AS user_id, count(*) AS messages
  FROM messages m
  LEFT JOIN guild_members gm
    ON gm.guild_id = m.guild_id AND gm.user_id = m.author_id
  WHERE m.guild_id = ? AND gm.user_id IS NULL
  GROUP BY m.author_id
  ORDER BY messages DESC
  LIMIT ?`;

/** Stamp resolved roles onto every message this author already wrote. */
const SQL_BACKFILL_MESSAGE_ROLES = `
  UPDATE messages
  SET author_role_names = @names, author_top_category = @top
  WHERE guild_id = @guild_id AND author_id = @user_id`;

export const usersRepo = {
  upsert(user: UserLike): void {
    prepare(SQL_UPSERT_USER).run({
      id: user.id,
      username: user.username ?? '(unknown)',
      global_name: user.global_name ?? null,
      discriminator: user.discriminator ?? null,
      avatar: user.avatar ?? null,
      is_bot: bit(user.bot),
      is_system: bit(user.system),
    });
  },

  /**
   * Record a member observation: their nickname, join date, and role set at the
   * moment we saw them. Role rows are additive — we never delete a previously
   * observed role, because a message written last year was written under the
   * roles the author held last year.
   */
  observeMember(params: {
    guildId: string;
    userId: string;
    nick?: string | null;
    joinedAt?: string | null;
    roleIds: string[];
    roleLookup: Map<string, RoleLookupEntry>;
  }): ResolvedRoles {
    const { guildId, userId, nick, joinedAt, roleIds, roleLookup } = params;

    const names: string[] = [];
    const categories: string[] = [];
    for (const roleId of roleIds) {
      const entry = roleLookup.get(roleId);
      if (entry) {
        names.push(entry.name);
        categories.push(entry.category);
      }
    }
    const top = topCategory(categories);

    if (roleIds.length) {
      const stmt = prepare(SQL_INSERT_MEMBER_ROLE);
      for (const roleId of roleIds) stmt.run(guildId, userId, roleId);
    }

    prepare(SQL_UPSERT_MEMBER).run({
      guild_id: guildId,
      user_id: userId,
      nick: nick ?? null,
      joined_at: joinedAt ?? null,
      role_names: names.join(', '),
      top_category: top,
    });

    return { names, top };
  },

  /** Authors with messages but no resolved roles, busiest first. */
  pendingEnrichment(guildId: string, limit: number): Array<{ user_id: string; messages: number }> {
    return prepare(SQL_PENDING_ENRICHMENT).all(guildId, limit) as Array<{
      user_id: string;
      messages: number;
    }>;
  },

  /**
   * Apply resolved roles to this author's existing messages.
   *
   * Messages are collected before roles can be resolved (Discord doesn't send
   * `member` over REST), so the role snapshot on each message is written
   * retroactively here. Returns how many rows were updated.
   */
  backfillMessageRoles(guildId: string, userId: string, roles: ResolvedRoles): number {
    const result = prepare(SQL_BACKFILL_MESSAGE_ROLES).run({
      guild_id: guildId,
      user_id: userId,
      names: roles.names.length ? roles.names.join(', ') : null,
      top: roles.top,
    });
    return result.changes;
  },

  /** Cached membership, used when a message payload carries no `member` object. */
  getMembership(guildId: string, userId: string): ResolvedRoles | null {
    const row = prepare(SQL_GET_MEMBER).get(guildId, userId) as
      | { role_names: string | null; top_category: string }
      | undefined;

    if (!row || !row.role_names) return null;
    return {
      names: row.role_names.split(', ').filter(Boolean),
      top: row.top_category as RoleCategory,
    };
  },
};
