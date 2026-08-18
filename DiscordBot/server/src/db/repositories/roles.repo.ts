/** 🎭 Role persistence + the in-memory role→name/category lookup. */
import { getDb, bit } from '../client.js';
import { classifyRole, type RoleCategory } from '../roleCategory.js';
import type { RoleInputT } from '../../ingest/schemas.js';

export interface RoleLookupEntry {
  name: string;
  category: RoleCategory;
}

export const rolesRepo = {
  upsertMany(guildId: string, roles: RoleInputT[]): number {
    const stmt = getDb().prepare(
      `INSERT INTO roles (id, guild_id, name, color, position, hoist, managed,
                          mentionable, permissions, category, subnet_uid, raw_json, updated_at)
       VALUES (@id, @guild_id, @name, @color, @position, @hoist, @managed,
               @mentionable, @permissions, @category, @subnet_uid, @raw_json, datetime('now'))
       ON CONFLICT(guild_id, id) DO UPDATE SET
         name        = excluded.name,
         color       = excluded.color,
         position    = excluded.position,
         hoist       = excluded.hoist,
         managed     = excluded.managed,
         mentionable = excluded.mentionable,
         permissions = excluded.permissions,
         category    = excluded.category,
         subnet_uid  = excluded.subnet_uid,
         raw_json    = excluded.raw_json,
         updated_at  = datetime('now')`,
    );

    for (const role of roles) {
      const { category, subnetUid } = classifyRole(role.name);
      stmt.run({
        id: role.id,
        guild_id: guildId,
        name: role.name,
        color: role.color ?? 0,
        position: role.position ?? 0,
        hoist: bit(role.hoist),
        managed: bit(role.managed),
        mentionable: bit(role.mentionable),
        permissions: role.permissions != null ? String(role.permissions) : null,
        category,
        subnet_uid: subnetUid,
        raw_json: JSON.stringify(role),
      });
    }
    return roles.length;
  },

  /** All roles for a guild as `roleId → { name, category }`. */
  lookup(guildId: string): Map<string, RoleLookupEntry> {
    const rows = getDb()
      .prepare(`SELECT id, name, category FROM roles WHERE guild_id = ?`)
      .all(guildId) as Array<{ id: string; name: string; category: string }>;

    const map = new Map<string, RoleLookupEntry>();
    for (const r of rows) map.set(r.id, { name: r.name, category: r.category as RoleCategory });
    return map;
  },

  countByCategory(guildId: string): Record<string, number> {
    const rows = getDb()
      .prepare(`SELECT category, count(*) AS n FROM roles WHERE guild_id = ? GROUP BY category`)
      .all(guildId) as Array<{ category: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.category, r.n]));
  },
};
