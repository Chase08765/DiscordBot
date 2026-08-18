/**
 * 🧹 Destructive: drop every collected row. `npm run db:reset -- --yes`
 * The schema is left in place; only data is removed.
 */
import { getDb, closeDb, transaction } from '../db/client.js';
import { createLogger, EMOJI } from '../core/logger.js';

const log = createLogger('reset');

if (!process.argv.includes('--yes')) {
  console.error('\n⚠️  This deletes ALL collected Discord data.');
  console.error('   Re-run with:  npm run db:reset -- --yes\n');
  process.exit(1);
}

const TABLES = [
  'message_reactions',
  'message_mentions',
  'attachments',
  'messages',
  'member_roles',
  'guild_members',
  'users',
  'channels',
  'roles',
  'sync_runs',
  'guilds',
];

const db = getDb();
transaction(() => {
  for (const t of TABLES) {
    const { changes } = db.prepare(`DELETE FROM ${t}`).run();
    log.event(EMOJI.clean, 'info', 'cleared', { table: t, rows: changes });
  }
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
});
db.exec('VACUUM');

log.event(EMOJI.done, 'info', 'database reset');
closeDb();
