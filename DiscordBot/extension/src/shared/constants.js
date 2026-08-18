/**
 * 📌 Constants shared across the extension.
 *
 * Values that never change at runtime live here; anything a user might want to
 * tune lives in config.js instead.
 */

/** Discord's API base. v9 is what the web client itself uses. */
export const DISCORD_API = 'https://discord.com/api/v9';

/**
 * Discord channel types.
 * @see https://discord.com/developers/docs/resources/channel#channel-object-channel-types
 */
export const CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_DIRECTORY: 14,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
};

/** Channel types that hold fetchable message history. */
export const READABLE_CHANNEL_TYPES = new Set([
  CHANNEL_TYPE.GUILD_TEXT,
  CHANNEL_TYPE.GUILD_ANNOUNCEMENT,
  CHANNEL_TYPE.PUBLIC_THREAD,
  CHANNEL_TYPE.ANNOUNCEMENT_THREAD,
]);

/** Message-channel classification, mirrored by the server's `channels.kind`. */
export const CHANNEL_KIND = {
  MAIN: 'main',
  SUBNET: 'subnet',
  OTHER: 'other',
  EXCLUDED: 'excluded',
};

/** Collector lifecycle states. */
export const RUN_STATE = {
  IDLE: 'idle',
  DISCOVERING: 'discovering',
  COLLECTING: 'collecting',
  WATCHING: 'watching',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  ERROR: 'error',
};

/** Message types passed between the popup and the service worker. */
export const MSG = {
  // popup → service worker
  GET_STATE: 'GET_STATE',
  START: 'START',
  STOP: 'STOP',
  DISCOVER: 'DISCOVER',
  ENRICH: 'ENRICH',
  WATCH_START: 'WATCH_START',
  WATCH_STOP: 'WATCH_STOP',

  // service worker → popup (broadcast)
  STATE_CHANGED: 'STATE_CHANGED',
};

/** Emoji vocabulary — keep in sync with server/src/core/logger.ts. */
export const EMOJI = {
  startup: '🚀',
  config: '⚙️',
  db: '🗄️',
  extension: '🧩',
  auth: '🔑',
  discover: '🔍',
  network: '📡',
  channel: '📚',
  fetched: '📥',
  saved: '💾',
  skipped: '⏭️',
  throttled: '🐌',
  paused: '⏸️',
  done: '✅',
  stats: '📊',
  user: '👤',
  role: '🎭',
  warn: '⚠️',
  error: '❌',
  clock: '🕐',
};
