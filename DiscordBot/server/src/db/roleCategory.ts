/**
 * 🎭 Role classification.
 *
 * Calibrated against the real Bittensor server (207 roles, read from a live
 * collection run). The naming conventions there are:
 *
 *   Moderator · Owner · Supermod · Mod (Holding) · Bot Admin    ← staff
 *   Opentensor                                                  ← foundation
 *   apex・1 · dsperse・2 · teutonic・3 · horde・12 · …            ← subnet teams
 *   MEE6 · Dyno · Sapphire · Translator · Telegram Bridge        ← bots
 *   verified · verified plus · Server Booster · Banned           ← membership
 *
 * The subnet-team roles are the important discovery: `<name>・<uid>` carries
 * the subnet number, so a message from someone holding `horde・12` can be
 * attributed to subnet 12 even though the role name says nothing about
 * "subnet". That number is extracted here, not just the category.
 */

export const ROLE_CATEGORIES = [
  'moderator',
  'team',
  'subnet_owner',
  'subnet_supporter',
  'contributor',
  'verified',
  'bot',
  'banned',
  'other',
] as const;

export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

/** Lower number = more authoritative. */
const RANK: Record<RoleCategory, number> = {
  moderator: 0,
  team: 1,
  subnet_owner: 2,
  subnet_supporter: 3,
  contributor: 4,
  verified: 5,
  bot: 6,
  banned: 7,
  other: 8,
};

/**
 * Normalise a role name for matching.
 * The middle-dot family (・ U+30FB, · U+00B7) is used as a separator in subnet
 * role names and lives in unrelated Unicode blocks, so it is listed explicitly.
 */
function normaliseRoleName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[\s_|/\\·•‧∙⋅・･–—]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
}

/**
 * Subnet team roles end in the subnet number: `apex・1` → 1, `horde・12` → 12.
 * Anchored to the end so `404-gen・17` yields 17, not 404.
 */
const SUBNET_ROLE = /-(\d{1,3})$/;

/**
 * Order matters — first match wins, so specific patterns sit above general
 * ones. Note `supermod` and `mod-(holding)` need explicit handling: a `\bmod\b`
 * word boundary does not fire inside "supermod".
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, RoleCategory]> = [
  // Bots first: "Bot Admin" must not be caught by the admin rule below.
  // Matched as a word rather than anchored, because the server has both `MEE6`
  // and `Bittensor MEE6`.
  [/\b(?:mee6|dyno|sapphire|carl-?bot|probot|arcane|invite-tracker|server-bots?)\b/i, 'bot'],
  [/\b(?:bot|webhook|integration|bridge|tracker|translator)\b/i, 'bot'],

  [/\bbanned\b|\bmuted\b|\bblacklist/i, 'banned'],

  // Before the moderator rule: `\bowner\b` there would otherwise swallow
  // "Subnet Owner", which is a completely different kind of authority.
  [/\bsubnet[\s-]*owner\b|\bsn[\s-]*owner\b/i, 'subnet_owner'],
  [/\bsubnet[\s-]*(?:supporter|support|helper|champion)\b/i, 'subnet_supporter'],

  [/supermod|\bmod\b|\bmoderator\b|\bowner\b|\badmin(?:istrator)?\b|\bstaff\b/i, 'moderator'],
  [/\bopentensor\b|\botf\b|\bcore-?team\b|\bfoundation\b|\bemployee\b/i, 'team'],

  [/\b(?:contributor|developer|builder|validator|miner|guest-speaker|stage-host)\b/i, 'contributor'],
  [/^verified(?:-plus)?$/i, 'verified'],
];

export interface RoleClassification {
  category: RoleCategory;
  /** Subnet this role denotes membership of, when the name encodes one. */
  subnetUid: number | null;
}

export function classifyRole(roleName: string): RoleClassification {
  const name = normaliseRoleName(roleName);

  // A trailing number means a subnet team role — the dominant shape in this
  // server, and worth checking before the generic keyword patterns.
  const subnetMatch = SUBNET_ROLE.exec(name);
  if (subnetMatch) {
    const uid = Number.parseInt(subnetMatch[1]!, 10);
    if (uid >= 0 && uid <= 128) {
      return { category: 'subnet_owner', subnetUid: uid };
    }
  }

  for (const [pattern, category] of PATTERNS) {
    if (pattern.test(name)) return { category, subnetUid: null };
  }

  return { category: 'other', subnetUid: null };
}

/** The most authoritative category from a list. Returns 'other' if empty. */
export function topCategory(categories: readonly string[]): RoleCategory {
  let best: RoleCategory = 'other';
  for (const c of categories) {
    const candidate = (ROLE_CATEGORIES as readonly string[]).includes(c)
      ? (c as RoleCategory)
      : 'other';
    if (RANK[candidate] < RANK[best]) best = candidate;
  }
  return best;
}
