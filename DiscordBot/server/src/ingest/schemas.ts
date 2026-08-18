/**
 * 📥 Ingest payload contract.
 *
 * The extension sends Discord's own API objects almost verbatim, plus a thin
 * layer of classification metadata (which channel is a subnet channel, how far
 * a backfill has got). Normalisation happens here on the server, so improving
 * the extraction logic later never requires re-harvesting Discord.
 *
 * Everything except `runId` is optional — a batch may carry only messages, only
 * a channel list, or only progress bookkeeping.
 */
import { z } from 'zod';

/** Discord snowflake: a numeric string. */
const Snowflake = z.string().regex(/^\d{5,25}$/, 'not a snowflake');

// ── 🏛️ Guild ────────────────────────────────────────────────────────────────
export const GuildInput = z.object({
  id: Snowflake,
  name: z.string().nullish(),
  icon: z.string().nullish(),
  description: z.string().nullish(),
});

// ── 🎭 Role ─────────────────────────────────────────────────────────────────
export const RoleInput = z.object({
  id: Snowflake,
  name: z.string(),
  color: z.number().int().nullish(),
  position: z.number().int().nullish(),
  hoist: z.boolean().nullish(),
  managed: z.boolean().nullish(),
  mentionable: z.boolean().nullish(),
  permissions: z.union([z.string(), z.number()]).nullish(),
});

// ── 📚 Channel ──────────────────────────────────────────────────────────────
export const ChannelKind = z.enum(['main', 'subnet', 'other', 'excluded']);

export const ChannelInput = z.object({
  id: Snowflake,
  name: z.string(),
  type: z.number().int(),
  parent_id: Snowflake.nullish(),
  position: z.number().int().nullish(),
  topic: z.string().nullish(),
  nsfw: z.boolean().nullish(),

  // Added by the extension's channel filter.
  kind: ChannelKind.default('other'),
  subnetUid: z.number().int().min(0).max(1024).nullish(),
  categoryName: z.string().nullish(),
});

// ── 👤 Author / member ──────────────────────────────────────────────────────
const AuthorInput = z.object({
  id: Snowflake,
  username: z.string(),
  global_name: z.string().nullish(),
  discriminator: z.string().nullish(),
  avatar: z.string().nullish(),
  bot: z.boolean().nullish(),
  system: z.boolean().nullish(),
});

/**
 * Partial guild-member object Discord attaches to messages fetched from a guild
 * text channel. This is where role IDs come from — see docs/ROLE_COVERAGE note
 * in the README: it is present on most, but not all, message payloads.
 */
const MemberInput = z.object({
  nick: z.string().nullish(),
  joined_at: z.string().nullish(),
  roles: z.array(Snowflake).default([]),
});

// ── 💬 Message ──────────────────────────────────────────────────────────────
export const MessageInput = z.object({
  id: Snowflake,
  channel_id: Snowflake,
  guild_id: Snowflake.nullish(),
  author: AuthorInput,
  member: MemberInput.nullish(),

  content: z.string().default(''),
  timestamp: z.string(),
  edited_timestamp: z.string().nullish(),
  type: z.number().int().default(0),
  pinned: z.boolean().nullish(),
  tts: z.boolean().nullish(),
  mention_everyone: z.boolean().nullish(),

  mentions: z.array(AuthorInput.partial({ username: true })).default([]),
  attachments: z
    .array(
      z.object({
        id: Snowflake,
        filename: z.string().nullish(),
        content_type: z.string().nullish(),
        size: z.number().int().nullish(),
        url: z.string().nullish(),
        proxy_url: z.string().nullish(),
        width: z.number().int().nullish(),
        height: z.number().int().nullish(),
      }),
    )
    .default([]),
  embeds: z.array(z.unknown()).default([]),
  reactions: z
    .array(
      z.object({
        count: z.number().int().default(0),
        emoji: z.object({ id: Snowflake.nullish(), name: z.string().nullish() }),
      }),
    )
    .default([]),

  message_reference: z.object({ message_id: Snowflake.nullish() }).nullish(),
  thread: z.object({ id: Snowflake }).nullish(),
});

// ── 🎫 Standalone member observation ────────────────────────────────────────
/**
 * Roles for one guild member, gathered by the enrichment pass.
 *
 * Necessary because Discord does NOT attach a `member` object to messages
 * fetched over REST — only to gateway MESSAGE_CREATE/UPDATE events. The first
 * live run confirmed this at 0/4394 messages. Roles therefore have to be
 * fetched per user and joined back on.
 */
export const MemberObservation = z.object({
  userId: Snowflake,
  nick: z.string().nullish(),
  joinedAt: z.string().nullish(),
  roleIds: z.array(Snowflake).default([]),
  /** Set when the profile lookup failed, so we don't retry it forever. */
  unavailable: z.boolean().nullish(),
});

// ── 📈 Per-channel sync progress ────────────────────────────────────────────
export const ChannelProgressInput = z.object({
  channelId: Snowflake,
  oldestSyncedMessageId: Snowflake.nullish(),
  newestSyncedMessageId: Snowflake.nullish(),
  backfillComplete: z.boolean().nullish(),
  /**
   * Date cut-off the backfill stopped at, or null when it reached the channel's
   * true first message. Paired with `backfillComplete` so a later, earlier
   * horizon can resume instead of being skipped.
   */
  backfillHorizon: z.string().nullish(),
});

// ── 📦 The batch ────────────────────────────────────────────────────────────
export const IngestBatch = z.object({
  runId: z.string().min(1).max(64),
  mode: z.enum(['discover', 'backfill', 'incremental', 'enrich']).default('backfill'),
  guild: GuildInput.optional(),
  roles: z.array(RoleInput).optional(),
  channels: z.array(ChannelInput).optional(),
  messages: z.array(MessageInput).optional(),
  members: z.array(MemberObservation).optional(),
  channelProgress: z.array(ChannelProgressInput).optional(),
});

export type GuildInputT = z.infer<typeof GuildInput>;
export type RoleInputT = z.infer<typeof RoleInput>;
export type ChannelInputT = z.infer<typeof ChannelInput>;
export type MessageInputT = z.infer<typeof MessageInput>;
export type ChannelProgressInputT = z.infer<typeof ChannelProgressInput>;
export type MemberObservationT = z.infer<typeof MemberObservation>;
export type IngestBatchT = z.infer<typeof IngestBatch>;

// ── 🏃 Sync run lifecycle ───────────────────────────────────────────────────
export const SyncRunStart = z.object({
  runId: z.string().min(1).max(64),
  guildId: Snowflake.optional(),
  mode: z.enum(['discover', 'backfill', 'incremental', 'enrich']).default('backfill'),
});

export const SyncRunFinish = z.object({
  runId: z.string().min(1).max(64),
  status: z.enum(['completed', 'failed', 'aborted']),
  error: z.string().max(2000).optional(),
});
