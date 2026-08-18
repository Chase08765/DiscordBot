/**
 * 🐌 Rate limiting.
 *
 * Three layers, cheapest first:
 *
 *   1. FIXED PACING     — never issue two requests closer than `requestDelayMs`.
 *      This alone keeps us far below Discord's ~50 req/s global limit.
 *
 *   2. PROACTIVE BACKOFF — Discord tells us how much bucket budget is left via
 *      `X-RateLimit-Remaining` / `X-RateLimit-Reset-After`. When the bucket is
 *      down to its last request we wait out the reset instead of eating a 429.
 *      undiscord does not do this; it just absorbs the 429s.
 *
 *   3. REACTIVE BACKOFF — on 429, honour `retry_after` (seconds, float) times a
 *      configurable factor. A `global: true` response means we tripped the
 *      account-wide limit, which is the serious one, so we wait much longer.
 */
import { createLogger } from '../shared/logger.js';
import { EMOJI } from '../shared/constants.js';

const log = createLogger('ratelimit');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.requestDelayMs  minimum spacing between requests
   * @param {number} opts.backoffFactor   multiplier applied to retry_after
   * @param {number} opts.maxBackoffMs    ceiling on any single wait
   */
  constructor({ requestDelayMs, backoffFactor, maxBackoffMs }) {
    this.requestDelayMs = requestDelayMs;
    this.backoffFactor = backoffFactor;
    this.maxBackoffMs = maxBackoffMs;

    this.lastRequestAt = 0;
    /** Timestamp until which every request must wait — set by a 429. */
    this.blockedUntil = 0;

    this.stats = { requests: 0, throttled: 0, globalThrottled: 0, totalWaitMs: 0 };
  }

  /** Await before every request. Applies fixed pacing and any active penalty. */
  async acquire() {
    const now = Date.now();

    if (this.blockedUntil > now) {
      const waitMs = this.blockedUntil - now;
      // Only worth reporting when it is an actual stall. Discord empties the
      // per-channel bucket on almost every request and refills it in a fraction
      // of a second, so logging every sub-second pause drowned out everything
      // else — the log was ~95% "waiting out rate limit ms=240".
      if (waitMs >= 1000) {
        log.event(EMOJI.paused, 'info', 'waiting out rate limit', { ms: waitMs });
      }
      this.stats.totalWaitMs += waitMs;
      await sleep(waitMs);
    }

    const sinceLast = Date.now() - this.lastRequestAt;
    if (sinceLast < this.requestDelayMs) {
      await sleep(this.requestDelayMs - sinceLast);
    }

    this.lastRequestAt = Date.now();
    this.stats.requests++;
  }

  /**
   * Feed every response here. Returns the number of ms to wait before retrying
   * this same request, or 0 if the response should be processed normally.
   */
  async observe(response) {
    // ── Layer 2: proactive ───────────────────────────────────────────────────
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'));

    if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(resetAfter)) {
      // The old +250ms safety margin fired on nearly every request, because an
      // exhausted bucket with a sub-second reset is Discord's normal steady
      // state, not a warning sign. 50ms of jitter is enough to stay clear of
      // the boundary; the fixed `requestDelayMs` pacing does the real work.
      const waitMs = Math.min(Math.ceil(resetAfter * 1000) + 50, this.maxBackoffMs);
      log.event(EMOJI.throttled, 'debug', 'bucket exhausted, pre-emptive wait', { ms: waitMs });
      this.blockedUntil = Date.now() + waitMs;
    }

    if (response.status !== 429) return 0;

    // ── Layer 3: reactive ────────────────────────────────────────────────────
    this.stats.throttled++;

    let retryAfterSec = Number(response.headers.get('retry-after'));
    let isGlobal = false;

    // The JSON body is more precise (fractional seconds) and carries `global`.
    try {
      const body = await response.clone().json();
      if (typeof body.retry_after === 'number') retryAfterSec = body.retry_after;
      isGlobal = body.global === true;
    } catch {
      /* non-JSON 429; fall back to the header */
    }

    if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) retryAfterSec = 5;

    let waitMs = Math.ceil(retryAfterSec * 1000 * this.backoffFactor);
    if (isGlobal) {
      this.stats.globalThrottled++;
      // A global limit means Discord is unhappy with the account, not just this
      // bucket. Back off hard and slow the steady-state pace permanently.
      waitMs = Math.max(waitMs, 60_000);
      this.requestDelayMs = Math.min(this.requestDelayMs * 1.5, 10_000);
      log.event(EMOJI.error, 'error', 'GLOBAL rate limit hit — backing off hard', {
        waitMs,
        newDelayMs: Math.round(this.requestDelayMs),
      });
    } else {
      log.event(EMOJI.throttled, 'warn', 'rate limited', { retryAfter: retryAfterSec, waitMs });
    }

    waitMs = Math.min(waitMs, this.maxBackoffMs);
    this.blockedUntil = Date.now() + waitMs;
    this.stats.totalWaitMs += waitMs;
    return waitMs;
  }

  snapshot() {
    return { ...this.stats, currentDelayMs: Math.round(this.requestDelayMs) };
  }
}
