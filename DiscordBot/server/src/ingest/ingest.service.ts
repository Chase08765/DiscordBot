/**
 * 📥 Ingest orchestration.
 *
 * One batch → one transaction. Either the whole batch lands or none of it does,
 * so a network failure mid-request can never leave half-written state. The
 * extension is free to retry the identical batch; every write is idempotent.
 */
import { transaction } from '../db/client.js';
import { guildsRepo } from '../db/repositories/guilds.repo.js';
import { rolesRepo } from '../db/repositories/roles.repo.js';
import { channelsRepo } from '../db/repositories/channels.repo.js';
import { usersRepo, type ResolvedRoles } from '../db/repositories/users.repo.js';
import { messagesRepo } from '../db/repositories/messages.repo.js';
import { syncRunsRepo } from '../db/repositories/syncRuns.repo.js';
import { createLogger, EMOJI } from '../core/logger.js';
import type { IngestBatchT } from './schemas.js';

const log = createLogger('ingest');

export interface IngestResult {
  guild: string | null;
  roles: number;
  channels: number;
  messagesInserted: number;
  messagesSkipped: number;
  usersSeen: number;
  /** How many messages carried a `member` object we could read roles from. */
  roleCoverage: number;
  /** Members resolved by the enrichment pass, and messages retro-stamped. */
  membersResolved: number;
  messagesReStamped: number;
  durationMs: number;
}

export function ingestBatch(batch: IngestBatchT): IngestResult {
  const startedAt = Date.now();

  // Resolve which guild this batch belongs to. Nearly everything is scoped by
  // it, so bail early with a clear message rather than a foreign-key error.
  const guildId = batch.guild?.id ?? batch.messages?.find((m) => m.guild_id)?.guild_id ?? null;

  const result: IngestResult = {
    guild: guildId,
    roles: 0,
    channels: 0,
    messagesInserted: 0,
    messagesSkipped: 0,
    usersSeen: 0,
    roleCoverage: 0,
    membersResolved: 0,
    messagesReStamped: 0,
    durationMs: 0,
  };

  transaction(() => {
    // ── 🏛️ Guild ────────────────────────────────────────────────────────────
    if (batch.guild) guildsRepo.upsert(batch.guild);
    else if (guildId) guildsRepo.ensure(guildId);

    if (!guildId) {
      // A batch with no guild context can still be a valid progress-only ping.
      if (batch.channelProgress?.length) channelsRepo.updateProgress(batch.channelProgress);
      return;
    }

    // ── 🎭 Roles (before members, so lookups resolve) ────────────────────────
    if (batch.roles?.length) {
      result.roles = rolesRepo.upsertMany(guildId, batch.roles);
      log.event(EMOJI.role, 'info', 'roles upserted', {
        guild: guildId,
        count: result.roles,
        byCategory: rolesRepo.countByCategory(guildId),
      });
    }

    // ── 📚 Channels ─────────────────────────────────────────────────────────
    if (batch.channels?.length) {
      result.channels = channelsRepo.upsertMany(guildId, batch.channels);
      const subnets = batch.channels.filter((c) => c.kind === 'subnet').length;
      const main = batch.channels.filter((c) => c.kind === 'main').length;
      const excluded = batch.channels.filter((c) => c.kind === 'excluded').length;
      log.event(EMOJI.channel, 'info', 'channels upserted', {
        guild: guildId,
        total: result.channels,
        main,
        subnet: subnets,
        excluded,
      });
    }

    // ── 💬 Messages ─────────────────────────────────────────────────────────
    if (batch.messages?.length) {
      const roleLookup = rolesRepo.lookup(guildId);
      const seenUsers = new Set<string>();
      const ensuredChannels = new Set<string>();

      for (const msg of batch.messages) {
        if (!ensuredChannels.has(msg.channel_id)) {
          channelsRepo.ensure(msg.channel_id, guildId);
          ensuredChannels.add(msg.channel_id);
        }

        // 👤 Author + membership
        usersRepo.upsert(msg.author);
        seenUsers.add(msg.author.id);

        let roles: ResolvedRoles | null = null;
        if (msg.member) {
          result.roleCoverage++;
          roles = usersRepo.observeMember({
            guildId,
            userId: msg.author.id,
            nick: msg.member.nick,
            joinedAt: msg.member.joined_at,
            roleIds: msg.member.roles,
            roleLookup,
          });
        } else {
          // Fall back to whatever membership we already recorded for this user.
          roles = usersRepo.getMembership(guildId, msg.author.id);
        }

        // Mentioned users are worth recording too — they are often the people
        // who answer, and stage 3 wants to resolve <@id> back to a name.
        for (const mentioned of msg.mentions) {
          if (mentioned.id === msg.author.id) continue;
          usersRepo.upsert(mentioned);
          seenUsers.add(mentioned.id);
        }

        if (messagesRepo.insert(msg, guildId, roles)) result.messagesInserted++;
        else result.messagesSkipped++;
      }

      result.usersSeen = seenUsers.size;
    }

    // ── 🎫 Member enrichment ────────────────────────────────────────────────
    // Roles arrive AFTER the messages they belong to, because Discord will not
    // give us roles at message-fetch time. Each resolved member is therefore
    // also stamped back onto every message that author already wrote.
    if (batch.members?.length) {
      const roleLookup = rolesRepo.lookup(guildId);

      for (const member of batch.members) {
        if (member.unavailable) {
          // Record the attempt so the enrichment pass stops re-queuing them.
          usersRepo.observeMember({
            guildId,
            userId: member.userId,
            roleIds: [],
            roleLookup,
          });
          continue;
        }

        const roles = usersRepo.observeMember({
          guildId,
          userId: member.userId,
          nick: member.nick,
          joinedAt: member.joinedAt,
          roleIds: member.roleIds,
          roleLookup,
        });

        result.membersResolved++;
        result.messagesReStamped += usersRepo.backfillMessageRoles(guildId, member.userId, roles);
      }
    }

    // ── 📈 Progress ─────────────────────────────────────────────────────────
    if (batch.channelProgress?.length) channelsRepo.updateProgress(batch.channelProgress);

    // ── 📊 Run audit ────────────────────────────────────────────────────────
    syncRunsRepo.start(batch.runId, guildId, batch.mode);
    syncRunsRepo.addProgress(batch.runId, {
      messages: result.messagesInserted,
      skipped: result.messagesSkipped,
      channels: result.channels,
    });
  });

  result.durationMs = Date.now() - startedAt;

  if (result.membersResolved) {
    log.event(EMOJI.role, 'info', 'members enriched', {
      run: batch.runId,
      members: result.membersResolved,
      messagesReStamped: result.messagesReStamped,
      ms: result.durationMs,
    });
  }

  if (batch.messages?.length) {
    log.event(EMOJI.saved, 'info', 'batch stored', {
      run: batch.runId,
      new: result.messagesInserted,
      dup: result.messagesSkipped,
      users: result.usersSeen,
      roleInfo: `${result.roleCoverage}/${batch.messages.length}`,
      ms: result.durationMs,
    });
  }

  return result;
}
