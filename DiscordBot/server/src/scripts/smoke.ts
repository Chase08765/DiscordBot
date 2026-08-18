/**
 * 🧪 End-to-end smoke test: `npm run smoke`
 *
 * POSTs a realistic Discord payload at the running server and asserts the data
 * came back out correctly. Exercises the whole ingest path — zod validation,
 * every repository, role resolution, the role snapshot on messages, channel
 * classification storage, resume state, and FTS search.
 *
 * Requires the server to be running (`npm run dev`).
 */
const BASE = process.env.SMOKE_URL ?? 'http://127.0.0.1:8787';

const GUILD = '1120750674595024897';
const RUN = `smoke_${Date.now()}`;

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.error(`  ❌ ${label}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ''}`);
  }
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json: json as Record<string, unknown> };
}

async function get(path: string) {
  const response = await fetch(`${BASE}${path}`);
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json: json as Record<string, unknown> };
}

// Roles the collector would pull from GET /guilds/{id}/roles.
const ROLES = [
  { id: '900000000000000001', name: 'Moderator', color: 15844367, position: 90, hoist: true },
  { id: '900000000000000002', name: 'Subnet Owner', color: 3447003, position: 80, hoist: true },
  { id: '900000000000000003', name: 'Subnet Supporter', color: 10181046, position: 70 },
  { id: '900000000000000004', name: 'Verified', color: 0, position: 10 },
];

// Channels as the extension's filter would classify them.
const CHANNELS = [
  { id: '800000000000000001', name: 'announcements', type: 5, kind: 'main', categoryName: 'INFORMATION' },
  { id: '800000000000000002', name: 'sn12-apex', type: 0, kind: 'subnet', subnetUid: 12, categoryName: 'SUBNETS' },
  { id: '800000000000000003', name: 'ex-sn9-pretraining', type: 0, kind: 'excluded', categoryName: 'ARCHIVE' },
];

function message(overrides: Record<string, unknown>) {
  return {
    id: '1200000000000000001',
    channel_id: '800000000000000001',
    guild_id: GUILD,
    author: { id: '700000000000000001', username: 'const', global_name: 'Const', bot: false },
    content: 'placeholder',
    timestamp: '2025-03-01T10:00:00.000000+00:00',
    type: 0,
    mentions: [],
    attachments: [],
    embeds: [],
    reactions: [],
    ...overrides,
  };
}

async function main() {
  console.log(`\n🧪 Smoke test against ${BASE}\n`);

  // ── 1. health ─────────────────────────────────────────────────────────────
  console.log('1. Health');
  const health = await get('/api/health');
  check('server responds', health.status === 200, health.status);
  if (health.status !== 200) {
    console.error('\n   Server is not running. Start it with `npm run dev`.\n');
    process.exit(1);
  }

  // ── 2. guild + roles + channels ───────────────────────────────────────────
  console.log('\n2. Guild, roles, channels');
  const inventory = await post('/api/ingest', {
    runId: RUN,
    mode: 'discover',
    guild: { id: GUILD, name: 'Bittensor (smoke)' },
    roles: ROLES,
    channels: CHANNELS,
  });
  check('inventory accepted', inventory.status === 200, inventory.json);
  const invResult = inventory.json.result as Record<string, number>;
  check('4 roles stored', invResult?.roles === 4, invResult?.roles);
  check('3 channels stored', invResult?.channels === 3, invResult?.channels);

  // ── 3. messages with role context ─────────────────────────────────────────
  console.log('\n3. Messages + role snapshot');
  const messages = [
    message({
      id: '1200000000000000001',
      content: 'Subnet 12 emission schedule has been updated in the latest release.',
      // A moderator who is also a subnet owner → top category must be moderator.
      member: { nick: 'Const', joined_at: '2021-06-01T00:00:00+00:00', roles: ['900000000000000001', '900000000000000002'] },
    }),
    message({
      id: '1200000000000000002',
      channel_id: '800000000000000002',
      author: { id: '700000000000000002', username: 'sn12owner', global_name: 'Apex Dev', bot: false },
      content: 'We are deploying a new validator weight-setting policy for subnet 12 tomorrow.',
      timestamp: '2025-03-02T11:30:00.000000+00:00',
      member: { nick: null, joined_at: '2023-01-15T00:00:00+00:00', roles: ['900000000000000002'] },
      reactions: [{ count: 7, emoji: { id: null, name: '🔥' } }],
    }),
    message({
      id: '1200000000000000003',
      channel_id: '800000000000000002',
      author: { id: '700000000000000003', username: 'randominer', bot: false },
      content: 'How do I register on subnet 12?',
      timestamp: '2025-03-03T09:00:00.000000+00:00',
      // No `member` object — the common case. Roles must come out null.
      mentions: [{ id: '700000000000000002', username: 'sn12owner' }],
    }),
  ];

  const ingest = await post('/api/ingest', {
    runId: RUN,
    mode: 'backfill',
    guild: { id: GUILD },
    messages,
    channelProgress: [
      {
        channelId: '800000000000000002',
        oldestSyncedMessageId: '1200000000000000002',
        newestSyncedMessageId: '1200000000000000003',
        backfillComplete: true,
        backfillHorizon: '2026-01-01',
      },
    ],
  });
  check('messages accepted', ingest.status === 200, ingest.json);
  const res = ingest.json.result as Record<string, number>;
  check('3 inserted', res?.messagesInserted === 3, res?.messagesInserted);
  check('role coverage = 2 of 3', res?.roleCoverage === 2, res?.roleCoverage);

  // ── 4. idempotency ────────────────────────────────────────────────────────
  console.log('\n4. Idempotency (re-send the identical batch)');
  const repeat = await post('/api/ingest', { runId: RUN, guild: { id: GUILD }, messages });
  const repeatRes = repeat.json.result as Record<string, number>;
  check('0 inserted on replay', repeatRes?.messagesInserted === 0, repeatRes?.messagesInserted);
  check('3 counted as duplicates', repeatRes?.messagesSkipped === 3, repeatRes?.messagesSkipped);

  // ── 4b. known-ID check ────────────────────────────────────────────────────
  // Drives "don't save what we already have" — and lets the collector stop
  // paging a channel the moment it reaches stored territory.
  console.log('\n4b. Known-ID check');
  const knownCheck = await post('/api/messages/known', {
    ids: ['1200000000000000001', '1200000000000000002', '1200000000000000999'],
  });
  const knownIds = (knownCheck.json.known as string[]) ?? [];
  check('reports the two stored IDs', knownIds.length === 2, knownIds);
  check('does not report the unstored one', !knownIds.includes('1200000000000000999'), knownIds);

  const emptyCheck = await post('/api/messages/known', { ids: [] });
  check('empty input is not an error', emptyCheck.status === 200, emptyCheck.status);

  const totalsCheck = await get(`/api/totals/${GUILD}`);
  const guildTotals = totalsCheck.json.totals as Record<string, number>;
  check('guild totals report 3 messages', guildTotals?.messages === 3, guildTotals);

  // ── 5. role resolution ────────────────────────────────────────────────────
  console.log('\n5. Role resolution');
  const stats = await get('/api/stats');
  const byCategory = (stats.json.byRoleCategory as Array<{ category: string; messages: number }>) ?? [];
  const cat = (name: string) => byCategory.find((r) => r.category === name)?.messages ?? 0;

  check('moderator outranks subnet_owner for the dual-role user', cat('moderator') === 1, byCategory);
  check('subnet_owner message categorised', cat('subnet_owner') === 1, byCategory);
  check('roleless message falls back to other', cat('other') === 1, byCategory);

  const totals = stats.json.totals as Record<string, number>;
  check('3 messages total', totals?.messages === 3, totals);
  // 3 authors + 1 mentioned user who is also an author = 3 distinct.
  check('3 users total', totals?.users === 3, totals);

  // ── 6. channel classification survived the round-trip ─────────────────────
  console.log('\n6. Channel classification');
  const channels = await get(`/api/channels?guild=${GUILD}`);
  const rows = (channels.json.channels as Array<Record<string, unknown>>) ?? [];
  const byName = (n: string) => rows.find((r) => r.name === n);

  check('subnet channel kept its uid', byName('sn12-apex')?.subnet_uid === 12, byName('sn12-apex'));
  check('ex- channel is excluded', byName('ex-sn9-pretraining')?.kind === 'excluded');
  check('announcements is main', byName('announcements')?.kind === 'main');
  check('message_count backfilled', byName('sn12-apex')?.message_count === 2, byName('sn12-apex'));

  // ── 7. resume state ───────────────────────────────────────────────────────
  console.log('\n7. Resume state');
  const resume = await get(`/api/resume/${GUILD}`);
  const resumeRows = (resume.json.channels as Array<Record<string, unknown>>) ?? [];
  const sn12 = resumeRows.find((r) => r.name === 'sn12-apex');
  check('excluded channel omitted from resume', !resumeRows.some((r) => r.kind === 'excluded'));
  check('cursor recorded', sn12?.oldest_synced_message_id === '1200000000000000002', sn12);
  check('backfill flagged complete', sn12?.backfill_complete === 1, sn12);
  check('horizon recorded alongside completion', sn12?.backfill_horizon === '2026-01-01', sn12);

  // A mid-backfill checkpoint (complete=false) must not clobber the horizon —
  // otherwise a stop/start cycle would erase how far back we actually got.
  await post('/api/ingest', {
    runId: RUN,
    guild: { id: GUILD },
    channelProgress: [
      {
        channelId: '800000000000000002',
        oldestSyncedMessageId: '1200000000000000002',
        backfillComplete: false,
      },
    ],
  });
  const afterCheckpoint = ((await get(`/api/resume/${GUILD}`)).json.channels as Array<Record<string, unknown>>)
    ?.find((r) => r.name === 'sn12-apex');
  check('horizon survives a mid-backfill checkpoint', afterCheckpoint?.backfill_horizon === '2026-01-01', afterCheckpoint);

  // ── 8. full-text search ───────────────────────────────────────────────────
  console.log('\n8. Full-text search');
  const search = await get('/api/search?q=validator');
  const results = (search.json.results as Array<Record<string, unknown>>) ?? [];
  check('FTS finds the message', results.length === 1, results.length);
  check('joined role name came through', results[0]?.author_role_names === 'Subnet Owner', results[0]?.author_role_names);
  check('stemming works (deploying → deploy)', ((await get('/api/search?q=deploy')).json.results as unknown[])?.length === 1);

  // ── 9. member enrichment ──────────────────────────────────────────────────
  // The critical path: Discord never sends roles with messages, so roles arrive
  // later and must be stamped back onto messages already stored.
  console.log('\n9. Member enrichment');

  const queue = await get(`/api/members/pending/${GUILD}?limit=100`);
  const pendingUsers = (queue.json.users as Array<{ user_id: string; messages: number }>) ?? [];
  const pendingIds = pendingUsers.map((u) => u.user_id);

  // Only the roleless author (700…003) should be queued; the other two already
  // had a `member` object in their message payload.
  check('only the unresolved author is queued', pendingIds.length === 1, pendingUsers);
  check('it is the right author', pendingIds[0] === '700000000000000003', pendingIds);

  const enrich = await post('/api/ingest', {
    runId: RUN,
    mode: 'enrich',
    guild: { id: GUILD },
    members: [
      {
        userId: '700000000000000003',
        nick: 'Miner',
        joinedAt: '2024-08-01T00:00:00+00:00',
        roleIds: ['900000000000000003'], // Subnet Supporter
      },
    ],
  });
  const enrichResult = enrich.json.result as Record<string, number>;
  check('member resolved', enrichResult?.membersResolved === 1, enrichResult);
  check('their existing message was re-stamped', enrichResult?.messagesReStamped === 1, enrichResult);

  const afterEnrich = await get('/api/stats');
  const cats = (afterEnrich.json.byRoleCategory as Array<{ category: string; messages: number }>) ?? [];
  const catAfter = (n: string) => cats.find((r) => r.category === n)?.messages ?? 0;
  check('was other, now subnet_supporter', catAfter('subnet_supporter') === 1, cats);
  check('no messages left uncategorised', catAfter('other') === 0, cats);

  const coverage = afterEnrich.json.roleCoverage as { with_roles: number; total: number };
  check('role coverage now 3/3', coverage?.with_roles === 3 && coverage?.total === 3, coverage);

  const emptied = await get(`/api/members/pending/${GUILD}?limit=100`);
  check('queue is now empty', (emptied.json.users as unknown[])?.length === 0, emptied.json.users);

  // ── 10. run audit trail ───────────────────────────────────────────────────
  console.log('\n10. Run audit trail');
  await post('/api/run/finish', { runId: RUN, status: 'completed' });
  const runs = ((await get('/api/stats')).json.recentRuns as Array<Record<string, unknown>>) ?? [];
  const run = runs.find((r) => r.id === RUN);

  check('run recorded', Boolean(run), runs.map((r) => r.id));
  check('marked completed', run?.status === 'completed', run?.status);
  check('3 messages attributed to the run', run?.messages_ingested === 3, run?.messages_ingested);
  check('3 duplicates attributed to the run', run?.messages_skipped === 3, run?.messages_skipped);
  // Distinct membership, not a per-batch sum. All 3 authors now have rows:
  // 2 from their message payloads, 1 from the enrichment pass above.
  check('users_seen is distinct, not cumulative', run?.users_seen === 3, run?.users_seen);

  // ── done ──────────────────────────────────────────────────────────────────
  console.log(
    failures === 0
      ? '\n✅ All smoke checks passed.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ Smoke test crashed:', err);
  process.exit(1);
});
