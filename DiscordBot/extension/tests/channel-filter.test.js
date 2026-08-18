/**
 * 🧪 Channel classification tests: `npm test` (from extension/)
 *
 * This is the logic you will actually have to tune against the real Bittensor
 * server, so it is worth locking down. Pure functions, no chrome.* APIs — runs
 * in plain Node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyChannels, normalise, extractSubnetUid } from '../src/background/channel-filter.js';
import { DEFAULTS, compilePatterns } from '../src/shared/config.js';
import { CHANNEL_KIND } from '../src/shared/constants.js';

/** Build a channel object shaped like Discord's API response. */
const ch = (name, extra = {}) => ({
  id: String(Math.floor(Math.random() * 1e15)),
  name,
  type: 0,
  position: 0,
  ...extra,
});

function classify(names, extra = {}) {
  const channels = names.map((n) => (typeof n === 'string' ? ch(n) : n));
  const { classified } = classifyChannels(channels, { ...DEFAULTS, ...extra });
  return new Map(classified.map((c) => [c.name, c]));
}

// ── normalise ────────────────────────────────────────────────────────────────

test('normalise strips decoration so decorated names match plain ones', () => {
  assert.equal(normalise('『📢』sn-12・apex'), 'sn-12-apex');
  assert.equal(normalise('🔥 GENERAL 🔥'), 'general');
  assert.equal(normalise('sn12_apex'), 'sn12-apex');
  assert.equal(normalise('  spaced   out  '), 'spaced-out');
  assert.equal(normalise('τ·1-apex'), 'τ-1-apex');
});

// ── subnet extraction ────────────────────────────────────────────────────────

test('extractSubnetUid handles the naming shapes a Bittensor server uses', () => {
  const patterns = compilePatterns(DEFAULTS.subnetPatterns);
  const uid = (name) => extractSubnetUid(normalise(name), patterns, DEFAULTS);

  assert.equal(uid('sn12-apex'), 12);
  assert.equal(uid('sn-12-apex'), 12);
  assert.equal(uid('subnet-64'), 64);
  assert.equal(uid('subnet7'), 7);
  assert.equal(uid('netuid-3'), 3);
  assert.equal(uid('12-apex'), 12);
  assert.equal(uid('sn0-root'), 0);
  assert.equal(uid('sn128-edge'), 128);
});

/**
 * Real channel names read out of the live Bittensor server after the first
 * collection run. The five marked ✗ were the ones the original `[a-z]`-anchored
 * pattern silently dropped.
 */
test('extractSubnetUid handles the REAL Bittensor channel names', () => {
  const patterns = compilePatterns(DEFAULTS.subnetPatterns);
  const uid = (name) => extractSubnetUid(normalise(name), patterns, DEFAULTS);

  assert.equal(uid('0・rao・🏛'), 0);
  assert.equal(uid('000・root・🏛'), 0);
  assert.equal(uid('1・apex・𝛼'), 1);
  assert.equal(uid('12・horde・µ'), 12);
  assert.equal(uid('11・trajectory-rl・λ'), 11);

  // ✗ previously missed — Greek tau standing in for the letter "t"
  assert.equal(uid('3・τeuτonic・γ'), 3);
  assert.equal(uid('4・τargon・∆'), 4);
  // ✗ previously missed — a digit follows the separator
  assert.equal(uid('17・404—gen・ρ'), 17);
  // ✗ previously missed — Arabic and Tifinagh characters
  assert.equal(uid('65・τpn・ص'), 65);
  assert.equal(uid('120・ⴷffine・ⴷ'), 120);
});

test('deregistered ex- subnet channels are excluded', () => {
  // Real names: the `ex` marker is a middle segment, not a prefix.
  const result = classify(['history・daasi・ex-32', '_・brain-inactive・ex90', '12・horde・µ']);

  assert.equal(result.get('history・daasi・ex-32').kind, CHANNEL_KIND.EXCLUDED);
  assert.equal(result.get('_・brain-inactive・ex90').kind, CHANNEL_KIND.EXCLUDED);
  // The live subnet channel is untouched.
  assert.equal(result.get('12・horde・µ').kind, CHANNEL_KIND.SUBNET);
});

test('decorated main channel names still classify as main', () => {
  const result = classify(['❓・faq', '💭・general', '📜・releases', '📣・announcements', '📌・rules']);

  for (const name of ['❓・faq', '💭・general', '📜・releases', '📣・announcements', '📌・rules']) {
    assert.equal(result.get(name).kind, CHANNEL_KIND.MAIN, `${name} should be main`);
  }
});

test('extractSubnetUid rejects numbers outside the configured range', () => {
  const patterns = compilePatterns(DEFAULTS.subnetPatterns);
  const uid = (name) => extractSubnetUid(normalise(name), patterns, DEFAULTS);

  assert.equal(uid('sn129-toobig'), null, '129 is above subnetMax');
  assert.equal(uid('sn999'), null);
  assert.equal(uid('general'), null);
  assert.equal(uid('announcements'), null);
});

// ── the exclusion rule the user asked for ────────────────────────────────────

test('ex- channels are excluded, and exclusion beats subnet matching', () => {
  const result = classify(['ex-sn9-pretraining', 'sn9-pretraining', 'ex-subnet-4']);

  assert.equal(result.get('ex-sn9-pretraining').kind, CHANNEL_KIND.EXCLUDED);
  assert.equal(result.get('ex-subnet-4').kind, CHANNEL_KIND.EXCLUDED);
  // The live equivalent is still collected.
  assert.equal(result.get('sn9-pretraining').kind, CHANNEL_KIND.SUBNET);
  assert.equal(result.get('sn9-pretraining').subnetUid, 9);
});

test('archived and deprecated channels are excluded too', () => {
  const result = classify(['old-general', 'archived-sn3', 'sn3-lore-archive', 'deprecated-docs']);

  for (const name of ['old-general', 'archived-sn3', 'sn3-lore-archive', 'deprecated-docs']) {
    assert.equal(result.get(name).kind, CHANNEL_KIND.EXCLUDED, `${name} should be excluded`);
  }
});

// ── main channels ────────────────────────────────────────────────────────────

test('named main channels are classified as main', () => {
  const result = classify(['announcements', 'releases', 'general', 'help']);

  for (const name of ['announcements', 'releases', 'general', 'help']) {
    assert.equal(result.get(name).kind, CHANNEL_KIND.MAIN, `${name} should be main`);
  }
});

test('a channel inherits main from its category', () => {
  const category = { id: '999', name: 'INFORMATION', type: 4, position: 0 };
  const child = ch('read-me-first', { parent_id: '999' });

  const { classified } = classifyChannels([category, child], DEFAULTS);
  const entry = classified.find((c) => c.name === 'read-me-first');

  assert.equal(entry.kind, CHANNEL_KIND.MAIN);
  assert.equal(entry.categoryName, 'INFORMATION');
  assert.match(entry.reason, /main category/);
});

// ── channel types ────────────────────────────────────────────────────────────

test('voice and stage channels are excluded, categories are dropped entirely', () => {
  const channels = [
    ch('SUBNETS', { type: 4 }),
    ch('general-voice', { type: 2 }),
    ch('town-hall', { type: 13 }),
    ch('general', { type: 0 }),
    ch('announcements', { type: 5 }),
  ];
  const { classified, summary } = classifyChannels(channels, DEFAULTS);

  assert.equal(summary.categories, 1);
  assert.equal(classified.length, 4, 'the category itself is not returned');

  const byName = new Map(classified.map((c) => [c.name, c]));
  assert.equal(byName.get('general-voice').kind, CHANNEL_KIND.EXCLUDED);
  assert.equal(byName.get('town-hall').kind, CHANNEL_KIND.EXCLUDED);
  // Announcement channels (type 5) hold real history and must be readable.
  assert.equal(byName.get('announcements').kind, CHANNEL_KIND.MAIN);
  assert.equal(byName.get('announcements').readable, true);
});

// ── summary ──────────────────────────────────────────────────────────────────

test('summary counts every channel exactly once', () => {
  const channels = [
    ch('announcements', { type: 5 }),
    ch('general'),
    ch('sn1-apex'),
    ch('sn2-omron'),
    ch('ex-sn9-old'),
    ch('random-unmatched-channel'),
  ];
  const { classified, summary } = classifyChannels(channels, DEFAULTS);

  assert.equal(summary.main, 2);
  assert.equal(summary.subnet, 2);
  assert.equal(summary.excluded, 1);
  assert.equal(summary.other, 1);
  assert.equal(
    summary.main + summary.subnet + summary.excluded + summary.other,
    classified.length,
  );
});
