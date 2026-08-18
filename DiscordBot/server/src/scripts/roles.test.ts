/**
 * 🧪 Role classification: `npm run test:roles`
 *
 * Every name below was read out of the live Bittensor server (207 roles).
 * The first run put 199 of them in `other`, including every subnet team role —
 * these cases pin down the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRole, topCategory } from '../db/roleCategory.js';

const category = (name: string) => classifyRole(name).category;
const subnet = (name: string) => classifyRole(name).subnetUid;

test('subnet team roles are recognised and yield their subnet number', () => {
  // `<name>・<uid>` is the dominant shape and was 100% missed before.
  assert.deepEqual(classifyRole('apex・1'), { category: 'subnet_owner', subnetUid: 1 });
  assert.deepEqual(classifyRole('dsperse・2'), { category: 'subnet_owner', subnetUid: 2 });
  assert.deepEqual(classifyRole('horde・12'), { category: 'subnet_owner', subnetUid: 12 });
  assert.deepEqual(classifyRole('trajectory-rl・11'), { category: 'subnet_owner', subnetUid: 11 });
  assert.deepEqual(classifyRole('subvortex ・7'), { category: 'subnet_owner', subnetUid: 7 });
  assert.deepEqual(classifyRole('0xmarkets・35'), { category: 'subnet_owner', subnetUid: 35 });

  // Anchored at the end, so a leading number in the name does not win.
  assert.equal(subnet('404-gen・17'), 17);
});

test('two roles can point at the same subnet', () => {
  // Both exist in the real server at position 176/175.
  assert.equal(subnet('teutonic・3'), 3);
  assert.equal(subnet('templar・3'), 3);
});

test('staff roles are recognised, including the awkward ones', () => {
  assert.equal(category('Moderator'), 'moderator');
  assert.equal(category('Owner'), 'moderator');
  // "Supermod" has no word boundary before "mod" — the original \bmod\b missed it.
  assert.equal(category('Supermod'), 'moderator');
  assert.equal(category('Mod (Holding)'), 'moderator');
  assert.equal(category('Bot Admin'), 'bot', 'named bots win over the admin keyword');
});

test('the foundation role is recognised', () => {
  assert.equal(category('Opentensor'), 'team');
});

test('"Subnet Owner" is not swallowed by the plain "Owner" rule', () => {
  // The server has a literal `Owner` role, so the moderator pattern needs
  // \bowner\b — which matches "Subnet Owner" too unless ordered correctly.
  assert.equal(category('Owner'), 'moderator');
  assert.equal(category('Subnet Owner'), 'subnet_owner');
  assert.equal(category('SN Owner'), 'subnet_owner');
  assert.equal(category('Subnet Supporter'), 'subnet_supporter');
});

test('bots are recognised', () => {
  for (const name of ['MEE6', 'Bittensor MEE6', 'Dyno', 'Sapphire', 'Server Bots']) {
    assert.equal(category(name), 'bot', `${name} should be a bot`);
  }
  for (const name of ['Telegram Bridge', 'Invite Tracker', 'Translator']) {
    assert.equal(category(name), 'bot', `${name} should be a bot`);
  }
});

test('membership and moderation-state roles are bucketed', () => {
  assert.equal(category('verified'), 'verified');
  assert.equal(category('verified plus'), 'verified');
  assert.equal(category('Banned'), 'banned');
  assert.equal(category('Guest Speaker'), 'contributor');
  assert.equal(category('Stage Host'), 'contributor');
});

test('genuinely uncategorisable roles stay in other', () => {
  for (const name of ['Rao', 'Pleb', 'Doge', 'Tao of a million symmetries', 'Subnet']) {
    assert.equal(category(name), 'other', `${name} should be other`);
  }
});

test('a role number outside the subnet range is not a subnet role', () => {
  assert.equal(subnet('something・999'), null);
  assert.equal(subnet('Gang Signs [τ, τ]'), null);
});

test('topCategory picks the most authoritative role a member holds', () => {
  assert.equal(topCategory(['subnet_owner', 'moderator']), 'moderator');
  assert.equal(topCategory(['verified', 'subnet_owner']), 'subnet_owner');
  assert.equal(topCategory(['other', 'verified']), 'verified');
  assert.equal(topCategory([]), 'other');
});
