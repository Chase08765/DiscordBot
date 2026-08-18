/**
 * 🧪 Backfill resume decisions.
 *
 * `backfill_complete` on its own is ambiguous — it can mean "read every message
 * this channel ever had" or "read back as far as the configured date". These
 * tests pin down the difference, because getting it wrong means a channel is
 * silently never re-read after you widen the date range.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { needsBackfill } from '../src/background/collector.js';
import { DEFAULTS } from '../src/shared/config.js';

test('the default horizon is 2026-01-01', () => {
  assert.equal(DEFAULTS.backfillSinceIso, '2026-01-01');
});

test('a channel never backfilled always needs backfilling', () => {
  assert.equal(needsBackfill(undefined, '2026-01-01'), true, 'no resume state at all');
  assert.equal(needsBackfill({ complete: false }, '2026-01-01'), true);
  assert.equal(needsBackfill({ complete: false, horizon: '2026-01-01' }, '2026-01-01'), true);
});

test('a channel read to its true first message is never re-walked', () => {
  // horizon null = we hit the beginning of the channel, there is nothing older.
  assert.equal(needsBackfill({ complete: true, horizon: null }, '2026-01-01'), false);
  assert.equal(needsBackfill({ complete: true, horizon: null }, ''), false);
  assert.equal(needsBackfill({ complete: true, horizon: null }, '2020-01-01'), false);
});

test('a channel read to the same horizon is not re-walked', () => {
  assert.equal(needsBackfill({ complete: true, horizon: '2026-01-01' }, '2026-01-01'), false);
});

test('moving the horizon EARLIER resumes the backfill', () => {
  const done = { complete: true, horizon: '2026-01-01' };

  assert.equal(needsBackfill(done, '2025-01-01'), true, 'a year earlier');
  assert.equal(needsBackfill(done, '2025-12-31'), true, 'one day earlier');
  assert.equal(needsBackfill(done, ''), true, 'blank now means all history');
});

test('moving the horizon LATER does not re-walk — we already have more', () => {
  const done = { complete: true, horizon: '2026-01-01' };

  assert.equal(needsBackfill(done, '2026-06-01'), false);
  assert.equal(needsBackfill(done, '2026-01-02'), false);
});
