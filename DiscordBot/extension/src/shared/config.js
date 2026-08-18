/**
 * ⚙️ Extension configuration — the extension's answer to a `.env` file.
 *
 * ⚠️ THIS FILE IS THE ONLY PLACE SETTINGS LIVE. Edit a value here and reload
 * the extension at chrome://extensions.
 *
 * There used to be a Settings panel writing overrides into chrome.storage.
 * It was removed, and deliberately so: a stored override silently shadowed the
 * default forever, so fixing a bad value here had no effect and there was no
 * way to tell. One source of truth is worth more than an in-browser form.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔧 THE PART YOU WILL ACTUALLY NEED TO EDIT
 *
 * Channel naming in the Bittensor server can't be guessed from outside it. Run
 * 🔍 Discover in the popup first — it prints every visible channel and how the
 * rules below classified it, and writes nothing. Then tune SUBNET_PATTERNS /
 * MAIN_CHANNELS / EXCLUDE_PATTERNS until the classification looks right.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DEFAULTS = {
  // ── 📡 Ingest server ──────────────────────────────────────────────────────
  serverUrl: 'http://127.0.0.1:8787',
  /** Must match INGEST_KEY in server/.env. Empty = auth disabled. */
  ingestKey: '',

  // ── 🐌 Pacing ─────────────────────────────────────────────────────────────
  /**
   * Delay between consecutive Discord API calls, in ms.
   * Discord's global limit is ~50 req/s, so 1200ms is deliberately timid —
   * roughly 0.8 req/s. Raising this is safe; lowering it is what gets accounts
   * flagged. 100 messages per request means 1200ms ≈ 83 messages/second.
   */
  requestDelayMs: 1200,
  /** Extra delay after finishing a channel, in ms. */
  channelDelayMs: 2500,
  /** Multiplier applied to `retry_after` when Discord returns 429. */
  rateLimitBackoffFactor: 2,
  /** Hard ceiling on any single backoff wait, in ms (10 minutes). */
  maxBackoffMs: 600_000,
  /** Give up on a channel after this many consecutive failures. */
  maxChannelRetries: 3,

  // ── 📦 Batching ───────────────────────────────────────────────────────────
  /** Messages per Discord API request. 100 is Discord's maximum. */
  discordPageSize: 100,
  /** Messages accumulated before POSTing to the ingest server. */
  ingestBatchSize: 500,

  // ── 🎯 Scope ──────────────────────────────────────────────────────────────
  /**
   * Guild to collect from. Leave empty to auto-detect from the open Discord
   * tab's URL (discord.com/channels/<guildId>/<channelId>).
   */
  guildId: '',
  /**
   * Stop backfilling a channel once messages get older than this date.
   * `''` means no limit — walk back to the very first message in every channel.
   *
   * A horizon is strongly recommended: a busy channel can be years deep and an
   * unbounded harvest runs for hours. The horizon actually reached is recorded
   * per channel, so moving this date EARLIER later on correctly resumes the
   * backfill instead of skipping the channel as "already complete".
   */
  backfillSinceIso: '2026-01-01',
  /** Cap on messages per channel per run. 0 = unlimited. */
  maxMessagesPerChannel: 0,
  /** Skip messages authored by bots. Bittensor has noisy stat bots. */
  skipBotMessages: true,
  /** Skip system messages (joins, boosts, pins) — type !== 0 and !== 19. */
  skipSystemMessages: true,

  // ── 👁️ Watch mode ─────────────────────────────────────────────────────────
  /**
   * How often to sweep every channel for new messages, in minutes.
   *
   * Chrome enforces a 1-minute floor on alarm periods. A sweep itself takes
   * roughly `channels × requestDelayMs` — with ~260 channels at 1200ms that is
   * about 5 minutes of wall clock — so anything under ~10 leaves little idle
   * time between sweeps and hammers the API continuously. 15 is a calm default.
   */
  watchIntervalMinutes: 15,

  // ── 📚 Channel classification ─────────────────────────────────────────────
  /**
   * Named main channels. Matched case-insensitively against the channel name
   * with Discord's decorative characters stripped.
   */
  mainChannels: [
    'announcements',
    'releases',
    'general',
    'general-chat',
    'bittensor-general',
    'help',
    'support',
    'questions',
    'development',
    'dev-chat',
    'validators',
    'miners',
    'docs',
    'resources',
    'faq',
    'rules',
    'start-here',
    'roadmap',
    'governance',
    'proposals',
  ],

  /**
   * Category names whose every channel counts as `main`, even if the channel
   * name isn't in the list above. Matched as a case-insensitive substring.
   */
  mainCategories: ['information', 'general', 'announcements', 'community', 'support', 'development'],

  /**
   * Patterns that identify a subnet channel and capture its number in group 1.
   * Serialised as strings because chrome.storage cannot hold RegExp objects —
   * `compilePatterns()` below turns them back into regexes.
   *
   * Calibrated against the real server, where the dominant shape is
   * `<uid>・<name>・<symbol>` — e.g. `12・horde・µ`, `0・rao・🏛`.
   *
   * ⚠️ The second pattern deliberately does NOT require an ASCII letter after
   * the number. Channel names there are full of lookalike and non-Latin
   * characters — `3・τeuτonic・γ` (Greek tau for "t"), `65・τpn・ص` (Arabic),
   * `120・ⴷffine・ⴷ` (Tifinagh), `17・404—gen・ρ` (a digit) — and an `[a-z]`
   * requirement silently dropped all five of those subnets on the first run.
   */
  subnetPatterns: [
    '^(?:sn|subnet|netuid|net)[\\s\\-_·]*(\\d{1,3})(?:\\b|_)',
    '^(\\d{1,3})[\\s\\-_·]+\\S',
    '\\bsubnet[\\s\\-_]*(\\d{1,3})\\b',
    '\\bnetuid[\\s\\-_]*(\\d{1,3})\\b',
  ],

  /** Valid subnet range, inclusive. Anything outside is treated as `other`. */
  subnetMin: 0,
  subnetMax: 128,

  /**
   * Anything matching these is classified `excluded` and never collected.
   * The `ex-` rules cover deprecated / former subnet channels, which the user
   * explicitly does not want.
   */
  excludePatterns: [
    // Deregistered subnets. The real server names them `history・daasi・ex-32`
    // and `_・brain-inactive・ex90`, so the `ex` marker is a SEGMENT carrying
    // the old subnet number — not a prefix. Matching only `^ex-` missed both.
    '(?:^|-)ex-?\\d{1,3}(?:$|-)',
    '^ex[\\s\\-_·]',
    '[\\s\\-_·]ex$',
    '\\binactive\\b',
    '^(?:old|archive|archived|deprecated|deregistered)[\\s\\-_·]',
    '[\\s\\-_·](?:archive|archived|deprecated|deregistered)$',
    '\\bvoice\\b',
    '\\bstage\\b',
  ],

  // ── 📜 Logging ────────────────────────────────────────────────────────────
  /**
   * trace | debug | info | warn | error
   * Logs go to the service worker console only — chrome://extensions →
   * this extension → "service worker".
   */
  logLevel: 'info',
};

/**
 * The active configuration.
 *
 * Async purely so call sites don't all have to change if a storage layer ever
 * comes back. Today it is simply DEFAULTS.
 */
export async function getConfig() {
  return DEFAULTS;
}

/** Turn an array of pattern strings into case-insensitive RegExps, skipping bad ones. */
export function compilePatterns(patterns) {
  const compiled = [];
  for (const p of patterns) {
    try {
      compiled.push(new RegExp(p, 'i'));
    } catch {
      console.warn(`⚠️ [config] ignoring invalid pattern: ${p}`);
    }
  }
  return compiled;
}
