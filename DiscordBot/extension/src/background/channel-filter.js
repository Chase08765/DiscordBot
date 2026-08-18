/**
 * 🔍 Channel classification.
 *
 * Turns Discord's flat channel list into the three buckets the pipeline cares
 * about:
 *
 *   main     → announcements, releases, general, … (server-wide channels)
 *   subnet   → a numbered subnet channel, 0–128, with the number extracted
 *   excluded → ex-* / archived / deprecated / voice — never collected
 *   other    → visible, readable, but unclassified (still collected by default)
 *
 * Discord channel names are lowercase and hyphenated, but people decorate them
 * heavily with emoji, box-drawing characters and the τ symbol. `normalise()`
 * strips all of that before any pattern runs, so `『📢』sn-12・apex` and
 * `sn12-apex` classify identically.
 */
import { CHANNEL_KIND, CHANNEL_TYPE, READABLE_CHANNEL_TYPES } from '../shared/constants.js';
import { compilePatterns } from '../shared/config.js';

/**
 * Every character Discord users press into service as a word separator.
 * The middle-dot family is the fiddly part: U+00B7 ·, U+2022 •, U+2027 ‧,
 * U+2219 ∙, U+22C5 ⋅, U+30FB ・ (katakana), U+FF65 ･ (halfwidth katakana).
 * They live in unrelated Unicode blocks, so they have to be listed explicitly.
 */
const SEPARATORS = /[\s_|/\\·•‧∙⋅・･–—]+/g;

/** Emoji, pictographs, variation selectors and ZWJ. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu;

/** Decorative brackets, box drawing, fullwidth punctuation. */
const DECORATION = /[\u{2500}-\u{257F}\u{3000}-\u{303F}\u{FF00}-\u{FF64}\u{FF66}-\u{FFEF}]/gu;

/**
 * Strip decoration down to comparable text, so `『📢』sn-12・apex` and
 * `sn12-apex` classify identically.
 *
 * Order matters: separators are normalised to hyphens BEFORE decoration is
 * deleted. The halfwidth katakana middle dot sits inside the fullwidth
 * punctuation block, so deleting decoration first would silently glue words
 * together (`sn12･apex` → `sn12apex`) instead of separating them.
 */
export function normalise(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(SEPARATORS, '-')
    .replace(EMOJI, '')
    .replace(DECORATION, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
}

/**
 * Classify every channel in a guild.
 *
 * @param {Array<object>} rawChannels  response from GET /guilds/{id}/channels
 * @param {object} config              merged extension config
 * @returns {{ classified: Array<object>, summary: object }}
 */
export function classifyChannels(rawChannels, config) {
  const subnetPatterns = compilePatterns(config.subnetPatterns);
  const excludePatterns = compilePatterns(config.excludePatterns);
  const mainNames = new Set(config.mainChannels.map(normalise));
  const mainCategories = config.mainCategories.map((c) => normalise(c));

  // Categories are channels too (type 4). Build id → name so we can show and
  // match on the parent category.
  const categoryNames = new Map();
  for (const c of rawChannels) {
    if (c.type === CHANNEL_TYPE.GUILD_CATEGORY) categoryNames.set(c.id, c.name);
  }

  const classified = [];
  const summary = { main: 0, subnet: 0, other: 0, excluded: 0, categories: 0, unreadable: 0 };

  for (const channel of rawChannels) {
    if (channel.type === CHANNEL_TYPE.GUILD_CATEGORY) {
      summary.categories++;
      continue; // categories hold no messages
    }

    const categoryName = channel.parent_id ? (categoryNames.get(channel.parent_id) ?? null) : null;
    const name = normalise(channel.name);
    const categoryNorm = normalise(categoryName ?? '');

    const entry = {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parent_id: channel.parent_id ?? null,
      position: channel.position ?? 0,
      topic: channel.topic ?? null,
      nsfw: Boolean(channel.nsfw),
      categoryName,
      kind: CHANNEL_KIND.OTHER,
      subnetUid: null,
      /** Not sent to the server — drives the collector's channel loop. */
      readable: READABLE_CHANNEL_TYPES.has(channel.type),
      /** Human-readable justification, shown in the Discover report. */
      reason: '',
    };

    // ── 1. Exclusions win over everything ───────────────────────────────────
    const excludeHit = excludePatterns.find((p) => p.test(name) || p.test(categoryNorm));
    if (excludeHit) {
      entry.kind = CHANNEL_KIND.EXCLUDED;
      entry.reason = `matched exclude ${excludeHit}`;
      summary.excluded++;
      classified.push(entry);
      continue;
    }

    // ── 2. Not a message-bearing channel type ───────────────────────────────
    if (!entry.readable && channel.type !== CHANNEL_TYPE.GUILD_FORUM) {
      entry.kind = CHANNEL_KIND.EXCLUDED;
      entry.reason = `channel type ${channel.type} has no message history`;
      summary.excluded++;
      summary.unreadable++;
      classified.push(entry);
      continue;
    }

    // ── 3. Subnet channels ──────────────────────────────────────────────────
    const subnetUid = extractSubnetUid(name, subnetPatterns, config);
    if (subnetUid !== null) {
      entry.kind = CHANNEL_KIND.SUBNET;
      entry.subnetUid = subnetUid;
      entry.reason = `subnet ${subnetUid}`;
      summary.subnet++;
      classified.push(entry);
      continue;
    }

    // ── 4. Main channels ────────────────────────────────────────────────────
    if (mainNames.has(name)) {
      entry.kind = CHANNEL_KIND.MAIN;
      entry.reason = 'named main channel';
      summary.main++;
      classified.push(entry);
      continue;
    }
    const categoryHit = mainCategories.find((c) => c && categoryNorm.includes(c));
    if (categoryHit) {
      entry.kind = CHANNEL_KIND.MAIN;
      entry.reason = `category "${categoryName}" is a main category`;
      summary.main++;
      classified.push(entry);
      continue;
    }

    // ── 5. Everything else ──────────────────────────────────────────────────
    entry.reason = 'no rule matched';
    summary.other++;
    classified.push(entry);
  }

  return { classified, summary };
}

/**
 * Pull a subnet number out of a normalised channel name.
 * Returns null if no pattern matches or the number is out of range.
 */
export function extractSubnetUid(normalisedName, patterns, config) {
  for (const pattern of patterns) {
    const match = normalisedName.match(pattern);
    if (!match) continue;

    const uid = Number.parseInt(match[1], 10);
    if (!Number.isInteger(uid)) continue;
    if (uid < config.subnetMin || uid > config.subnetMax) continue;

    return uid;
  }
  return null;
}

/**
 * Which channels should this run actually read?
 * Excluded channels are stored for the record but never fetched.
 */
export function collectableChannels(classified) {
  return classified.filter((c) => c.kind !== CHANNEL_KIND.EXCLUDED && c.readable);
}

/** Strip collector-only fields before sending to the ingest server. */
export function toIngestChannel(entry) {
  const { readable, reason, ...rest } = entry;
  return rest;
}
