/** 🏛️ Guild persistence. */
import { getDb } from '../client.js';
import type { GuildInputT } from '../../ingest/schemas.js';

export const guildsRepo = {
  upsert(guild: GuildInputT): void {
    getDb()
      .prepare(
        `INSERT INTO guilds (id, name, icon, description, last_synced_at)
         VALUES (@id, @name, @icon, @description, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name           = COALESCE(excluded.name, guilds.name),
           icon           = COALESCE(excluded.icon, guilds.icon),
           description    = COALESCE(excluded.description, guilds.description),
           last_synced_at = datetime('now')`,
      )
      .run({
        id: guild.id,
        name: guild.name ?? null,
        icon: guild.icon ?? null,
        description: guild.description ?? null,
      });
  },

  /** Ensure a row exists so foreign keys resolve, even before we know the name. */
  ensure(guildId: string): void {
    getDb()
      .prepare(`INSERT INTO guilds (id) VALUES (?) ON CONFLICT(id) DO NOTHING`)
      .run(guildId);
  },
};
