/**
 * 📊 CLI report: `npm run db:stats`
 * A quick "did the collection actually work?" check without curling the API.
 */
import { getDb, closeDb } from '../db/client.js';
import { messagesRepo } from '../db/repositories/messages.repo.js';

function table(title: string, rows: Record<string, unknown>[]): void {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log('  (none)');
    return;
  }
  console.table(rows);
}

const db = getDb();

console.log('\n📊 ─── Bittensor Discord collection report ───────────────────────');
console.table(messagesRepo.totals());

const span = db
  .prepare(`SELECT min(created_at) AS oldest, max(created_at) AS newest FROM messages`)
  .get() as { oldest: string | null; newest: string | null };
console.log(`\n🕐 Message range: ${span.oldest ?? '—'}  →  ${span.newest ?? '—'}`);

table(
  '📚 By channel kind',
  db
    .prepare(
      `SELECT c.kind,
              count(DISTINCT c.id) AS channels,
              count(m.id)          AS messages
       FROM channels c LEFT JOIN messages m ON m.channel_id = c.id
       GROUP BY c.kind ORDER BY messages DESC`,
    )
    .all() as Record<string, unknown>[],
);

table(
  '🎭 Messages by author role category',
  db
    .prepare(
      `SELECT author_top_category AS category, count(*) AS messages
       FROM messages GROUP BY author_top_category ORDER BY messages DESC`,
    )
    .all() as Record<string, unknown>[],
);

table(
  '🔢 Subnet coverage (top 20)',
  db
    .prepare(
      `SELECT subnet_uid, name, message_count, backfill_complete
       FROM channels WHERE kind = 'subnet'
       ORDER BY message_count DESC LIMIT 20`,
    )
    .all() as Record<string, unknown>[],
);

table(
  '🏆 Busiest channels',
  db
    .prepare(
      `SELECT name, kind, message_count, backfill_complete, last_synced_at
       FROM channels WHERE message_count > 0
       ORDER BY message_count DESC LIMIT 15`,
    )
    .all() as Record<string, unknown>[],
);

const coverage = db
  .prepare(
    `SELECT (SELECT count(*) FROM messages WHERE author_role_names IS NOT NULL) AS with_roles,
            (SELECT count(*) FROM messages) AS total`,
  )
  .get() as { with_roles: number; total: number };
const pct = coverage.total ? ((coverage.with_roles / coverage.total) * 100).toFixed(1) : '0.0';
console.log(`\n🎫 Role coverage: ${coverage.with_roles}/${coverage.total} messages (${pct}%)`);

table('🏃 Recent runs', db.prepare(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 10`).all() as Record<string, unknown>[]);

console.log('');
closeDb();
