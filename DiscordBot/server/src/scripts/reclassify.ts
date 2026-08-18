/**
 * 🎭 Re-apply role classification to roles already stored: `npm run db:reclassify`
 *
 * Role names are classified on ingest, so improving the patterns in
 * roleCategory.ts does nothing to rows already in the database. Rather than
 * re-fetching from Discord, this re-runs the classifier over the stored names
 * and updates `category` / `subnet_uid` in place — then re-stamps every
 * affected message and member so the corpus stays consistent.
 *
 * Pass --dry to preview without writing.
 *
 * Note: CHANNEL classification lives in the extension, not here. To pick up
 * changes to the channel patterns, re-run 🔍 Discover in the popup — it is only
 * a few API calls.
 */
import { getDb, closeDb, transaction } from '../db/client.js';
import { classifyRole, topCategory, type RoleCategory } from '../db/roleCategory.js';
import { createLogger, EMOJI } from '../core/logger.js';

const log = createLogger('reclassify');
const dryRun = process.argv.includes('--dry');

const db = getDb();

const roles = db
  .prepare(`SELECT id, guild_id, name, category, subnet_uid FROM roles`)
  .all() as Array<{
  id: string;
  guild_id: string;
  name: string;
  category: string;
  subnet_uid: number | null;
}>;

if (!roles.length) {
  log.warn('no roles stored — run a collection first');
  closeDb();
  process.exit(0);
}

// ── 1. What would change? ────────────────────────────────────────────────────
const changes: Array<{ id: string; guild: string; name: string; from: string; to: RoleCategory; uid: number | null }> = [];

for (const role of roles) {
  const { category, subnetUid } = classifyRole(role.name);
  if (category !== role.category || subnetUid !== role.subnet_uid) {
    changes.push({
      id: role.id,
      guild: role.guild_id,
      name: role.name,
      from: role.category,
      to: category,
      uid: subnetUid,
    });
  }
}

console.log(`\n🎭 ${roles.length} roles stored, ${changes.length} would change\n`);

for (const c of changes.slice(0, 60)) {
  const uid = c.uid !== null ? ` (subnet ${c.uid})` : '';
  console.log(`   ${c.from.padEnd(16)} → ${(c.to + uid).padEnd(24)} ${c.name}`);
}
if (changes.length > 60) console.log(`   … and ${changes.length - 60} more`);

// ── 2. Resulting distribution ────────────────────────────────────────────────
const distribution: Record<string, number> = {};
for (const role of roles) {
  const { category } = classifyRole(role.name);
  distribution[category] = (distribution[category] ?? 0) + 1;
}
console.log('\n📊 New distribution:');
for (const [category, n] of Object.entries(distribution).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${category.padEnd(18)} ${n}`);
}

if (dryRun) {
  console.log('\n(dry run — nothing written)\n');
  closeDb();
  process.exit(0);
}

if (!changes.length) {
  console.log('\n✅ Already up to date.\n');
  closeDb();
  process.exit(0);
}

// ── 3. Apply ─────────────────────────────────────────────────────────────────
transaction(() => {
  const updateRole = db.prepare(
    `UPDATE roles SET category = ?, subnet_uid = ?, updated_at = datetime('now')
     WHERE guild_id = ? AND id = ?`,
  );
  for (const c of changes) updateRole.run(c.to, c.uid, c.guild, c.id);

  log.event(EMOJI.role, 'info', 'roles reclassified', { updated: changes.length });

  // Members hold a denormalised role summary, so recompute it from the links.
  const members = db
    .prepare(`SELECT guild_id, user_id FROM guild_members`)
    .all() as Array<{ guild_id: string; user_id: string }>;

  const rolesOf = db.prepare(
    `SELECT r.name, r.category FROM member_roles mr
     JOIN roles r ON r.guild_id = mr.guild_id AND r.id = mr.role_id
     WHERE mr.guild_id = ? AND mr.user_id = ?`,
  );
  const updateMember = db.prepare(
    `UPDATE guild_members SET role_names = ?, top_category = ?
     WHERE guild_id = ? AND user_id = ?`,
  );
  const updateMessages = db.prepare(
    `UPDATE messages SET author_role_names = ?, author_top_category = ?
     WHERE guild_id = ? AND author_id = ?`,
  );

  let membersTouched = 0;
  let messagesTouched = 0;

  for (const m of members) {
    const held = rolesOf.all(m.guild_id, m.user_id) as Array<{ name: string; category: string }>;
    const names = held.map((r) => r.name);
    const top = topCategory(held.map((r) => r.category));

    updateMember.run(names.join(', ') || null, top, m.guild_id, m.user_id);
    membersTouched++;
    messagesTouched += updateMessages.run(
      names.join(', ') || null,
      top,
      m.guild_id,
      m.user_id,
    ).changes;
  }

  log.event(EMOJI.user, 'info', 'members and messages re-stamped', {
    members: membersTouched,
    messages: messagesTouched,
  });
});

console.log('\n✅ Reclassified.\n');
closeDb();
