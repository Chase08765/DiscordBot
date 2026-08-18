/**
 * 📡 Discord REST client.
 *
 * Runs in the service worker, which has host permission for discord.com, so
 * there is no CORS boundary and the requests survive page navigation.
 *
 * ── Why not the /messages/search endpoint that undiscord uses? ──────────────
 * undiscord's job is to FIND a specific user's messages, so search is right for
 * it. Ours is to read whole channels, and search is a bad fit for that:
 *
 *   • 25 results per page vs 100
 *   • `offset` pagination that Discord caps at 5000 — you physically cannot
 *     page past the 5000th result, which makes full history impossible
 *   • results come back as conversation groups needing `hit === true` filtering
 *   • it is a far more expensive endpoint, hence a stricter rate-limit bucket
 *
 * `GET /channels/{id}/messages?before=<snowflake>` has none of those problems.
 * Snowflake cursors are stable, unbounded, and resumable across runs.
 */
import { DISCORD_API, EMOJI } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { RateLimiter } from './rate-limiter.js';

const log = createLogger('discord');

/** Thrown for HTTP failures so the collector can branch on `status`. */
export class DiscordApiError extends Error {
  constructor(status, message, body) {
    super(`${status}: ${message}`);
    this.name = 'DiscordApiError';
    this.status = status;
    this.body = body;
  }
}

export class DiscordApi {
  /**
   * @param {string} token       user auth token from the MAIN-world bridge
   * @param {RateLimiter} limiter
   */
  constructor(token, limiter) {
    this.token = token;
    this.limiter = limiter;
  }

  /**
   * One authenticated GET, with rate-limit handling and retry.
   * Retries only on 429 and 5xx — a 403 means "you can't read this channel",
   * which retrying will never fix.
   */
  async get(path, { retries = 3, signal } = {}) {
    let attempt = 0;

    for (;;) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      await this.limiter.acquire();

      let response;
      try {
        response = await fetch(`${DISCORD_API}${path}`, {
          method: 'GET',
          headers: {
            Authorization: this.token,
            Accept: 'application/json',
          },
          signal,
        });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (attempt++ >= retries) throw new DiscordApiError(0, `network: ${err.message}`);
        const backoff = 1000 * 2 ** attempt;
        log.event(EMOJI.warn, 'warn', 'network error, retrying', {
          path,
          attempt,
          backoffMs: backoff,
        });
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      const waitMs = await this.limiter.observe(response);
      if (waitMs > 0) {
        if (attempt++ >= retries) {
          throw new DiscordApiError(429, 'rate limited beyond retry budget');
        }
        continue; // limiter.acquire() will absorb the wait next loop
      }

      if (response.ok) return response.json();

      // 5xx → transient, worth another go.
      if (response.status >= 500 && attempt++ < retries) {
        log.event(EMOJI.warn, 'warn', 'server error, retrying', {
          path,
          status: response.status,
          attempt,
        });
        continue;
      }

      const body = await response.text().catch(() => '');
      throw new DiscordApiError(response.status, response.statusText, body.slice(0, 300));
    }
  }

  /** 🏛️ Guild metadata. */
  getGuild(guildId, opts) {
    return this.get(`/guilds/${guildId}`, opts);
  }

  /** 🎭 Every role in the guild — this is what turns role IDs into names. */
  getRoles(guildId, opts) {
    return this.get(`/guilds/${guildId}/roles`, opts);
  }

  /** 📚 Every channel we can see, including categories (type 4). */
  getChannels(guildId, opts) {
    return this.get(`/guilds/${guildId}/channels`, opts);
  }

  /**
   * 💬 One page of messages, newest-first.
   *
   * @param {string} channelId
   * @param {object} params
   * @param {string} [params.before] snowflake — return messages OLDER than this
   * @param {string} [params.after]  snowflake — return messages NEWER than this
   * @param {number} [params.limit]  1–100
   */
  getMessages(channelId, { before, after, limit = 100 } = {}, opts) {
    const query = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
    if (before) query.set('before', before);
    if (after) query.set('after', after);
    return this.get(`/channels/${channelId}/messages?${query}`, opts);
  }

  /**
   * 🧵 Archived public threads in a channel. Forum channels keep all their real
   * content in threads, so without this a forum reads as empty.
   */
  getArchivedThreads(channelId, { before, limit = 100 } = {}, opts) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set('before', before);
    return this.get(`/channels/${channelId}/threads/archived/public?${query}`, opts);
  }

  /** 🔎 Confirms the token works and tells us who we are. */
  getCurrentUser(opts) {
    return this.get('/users/@me', opts);
  }

  /**
   * 🎫 One member's guild profile — the ONLY way we can get their roles.
   *
   * Discord does not attach a `member` object to messages fetched over REST;
   * it only does that for gateway MESSAGE_CREATE/UPDATE events. The first live
   * run confirmed this: 0 of 4394 messages carried role information.
   *
   * The bot endpoint `GET /guilds/{id}/members` requires the GUILD_MEMBERS
   * intent and 403s for user tokens. This profile endpoint is what the Discord
   * client itself calls when you click someone's avatar, so it works with the
   * session we have — at the cost of one request per user.
   *
   * @returns the `guild_member` object, or null if the profile is unavailable
   *          (left the server, blocked, privacy settings).
   */
  async getGuildMember(userId, guildId, opts) {
    const query = new URLSearchParams({
      guild_id: guildId,
      with_mutual_guilds: 'false',
    });
    const profile = await this.get(`/users/${userId}/profile?${query}`, opts);
    return profile?.guild_member ?? null;
  }
}

/**
 * 🕐 Discord snowflake → JS Date.
 * Upper 42 bits are ms since the Discord epoch (2015-01-01).
 */
export function snowflakeToDate(snowflake) {
  const DISCORD_EPOCH = 1420070400000n;
  return new Date(Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH));
}

/** Date → the smallest snowflake at or after that instant. Useful as a cursor. */
export function dateToSnowflake(date) {
  const DISCORD_EPOCH = 1420070400000n;
  return String((BigInt(date.getTime()) - DISCORD_EPOCH) << 22n);
}
