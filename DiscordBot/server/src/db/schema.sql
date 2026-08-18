-- ═════════════════════════════════════════════════════════════════════════════
-- 🗄️  Bittensor Discord knowledge base — schema
--
-- Design notes:
--   • Discord IDs are 64-bit snowflakes. SQLite INTEGER is 64-bit signed and
--     would technically hold them, but we store them as TEXT so that JSON
--     round-trips and JS `Number` precision can never corrupt an ID.
--   • A snowflake sorts chronologically as a string ONLY if zero-padded, which
--     Discord's are not (they vary in length). So we also keep a real
--     `created_at` timestamp for range queries and ordering.
--   • Everything is idempotent: re-ingesting the same batch is a no-op. That
--     matters because the collector retries on network failure.
-- ═════════════════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

-- ── 🏛️  Guilds (servers) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guilds (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  icon              TEXT,
  description       TEXT,
  first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at    TEXT
);

-- ── 🎭 Roles ─────────────────────────────────────────────────────────────────
-- The whole point of collecting these: knowing that a message came from a
-- "Subnet Owner" or a "Moderator" changes how much weight the answer stage
-- should give it.
CREATE TABLE IF NOT EXISTS roles (
  id                TEXT NOT NULL,
  guild_id          TEXT NOT NULL,
  name              TEXT NOT NULL,
  color             INTEGER NOT NULL DEFAULT 0,
  position          INTEGER NOT NULL DEFAULT 0,
  hoist             INTEGER NOT NULL DEFAULT 0,   -- displayed separately in member list
  managed           INTEGER NOT NULL DEFAULT 0,   -- managed by an integration/bot
  mentionable       INTEGER NOT NULL DEFAULT 0,
  permissions       TEXT,
  -- Coarse bucket derived on ingest so stage 2 can filter without knowing the
  -- server's exact role names. See db/roleCategory.ts.
  category          TEXT NOT NULL DEFAULT 'other',
  -- Bittensor names subnet team roles `<name>・<uid>` (apex・1, horde・12), so
  -- the role itself identifies a subnet. Extracted on ingest.
  subnet_uid        INTEGER,
  raw_json          TEXT,
  first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, id),
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_roles_category ON roles(guild_id, category);

-- ── 📚 Channels ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channels (
  id                     TEXT PRIMARY KEY,
  guild_id               TEXT NOT NULL,
  parent_id              TEXT,                  -- category channel, if any
  category_name          TEXT,                  -- denormalised for readability
  name                   TEXT NOT NULL,
  type                   INTEGER NOT NULL,      -- 0=text 5=announcement 15=forum …
  position               INTEGER NOT NULL DEFAULT 0,
  topic                  TEXT,
  nsfw                   INTEGER NOT NULL DEFAULT 0,

  -- Classification assigned by the extension's channel filter:
  --   'main'     → announcements / releases / general / …
  --   'subnet'   → a subnet channel, with subnet_uid set
  --   'other'    → visible but uncategorised
  --   'excluded' → matched an exclusion rule (e.g. ex-* channels)
  kind                   TEXT NOT NULL DEFAULT 'other',
  subnet_uid             INTEGER,               -- 0–128 when kind='subnet'

  -- Sync bookkeeping — lets a re-run resume instead of starting over.
  oldest_synced_message_id TEXT,                -- how far back we have gone
  newest_synced_message_id TEXT,                -- newest message we have stored
  backfill_complete        INTEGER NOT NULL DEFAULT 0,
  -- The date cut-off the backfill stopped at, or NULL if it reached the true
  -- first message. Without this, `backfill_complete` is ambiguous: "done" could
  -- mean "read everything" or "read back to the configured horizon", and moving
  -- the horizon earlier would silently skip the channel forever.
  backfill_horizon         TEXT,
  message_count            INTEGER NOT NULL DEFAULT 0,
  last_synced_at           TEXT,

  raw_json               TEXT,
  first_seen_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_channels_guild   ON channels(guild_id);
CREATE INDEX IF NOT EXISTS idx_channels_kind    ON channels(guild_id, kind);
CREATE INDEX IF NOT EXISTS idx_channels_subnet  ON channels(subnet_uid);

-- ── 👤 Users ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL,
  global_name       TEXT,                       -- the new display name
  discriminator     TEXT,                       -- legacy #0000, '0' post-migration
  avatar            TEXT,
  is_bot            INTEGER NOT NULL DEFAULT 0,
  is_system         INTEGER NOT NULL DEFAULT 0,
  first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ── 🎫 Guild membership: the user↔role link ──────────────────────────────────
CREATE TABLE IF NOT EXISTS guild_members (
  guild_id          TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  nick              TEXT,
  joined_at         TEXT,
  -- Denormalised, human-readable role summary, e.g. "Moderator, Subnet Owner".
  -- Recomputed on every observation so a plain SELECT is already readable.
  role_names        TEXT,
  -- Highest-privilege category among this member's roles (see roles.category).
  top_category      TEXT NOT NULL DEFAULT 'other',
  last_observed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_members_category ON guild_members(guild_id, top_category);

CREATE TABLE IF NOT EXISTS member_roles (
  guild_id          TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  role_id           TEXT NOT NULL,
  observed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_member_roles_role ON member_roles(guild_id, role_id);

-- ── 💬 Messages ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id                    TEXT PRIMARY KEY,
  channel_id            TEXT NOT NULL,
  guild_id              TEXT NOT NULL,
  author_id             TEXT NOT NULL,

  content               TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL,          -- ISO 8601, from the snowflake/API
  edited_at             TEXT,
  type                  INTEGER NOT NULL DEFAULT 0,
  pinned                INTEGER NOT NULL DEFAULT 0,
  tts                   INTEGER NOT NULL DEFAULT 0,

  -- Threading / replies
  referenced_message_id TEXT,
  thread_id             TEXT,

  -- Cheap counters so stage 2 can rank without joining or parsing JSON.
  attachment_count      INTEGER NOT NULL DEFAULT 0,
  embed_count           INTEGER NOT NULL DEFAULT 0,
  reaction_count        INTEGER NOT NULL DEFAULT 0,
  mention_count         INTEGER NOT NULL DEFAULT 0,
  mentions_everyone     INTEGER NOT NULL DEFAULT 0,

  -- Author's role context AT COLLECTION TIME. Snapshotted onto the message
  -- because roles change, and "who was a subnet owner when they said this"
  -- is the question we actually care about.
  author_role_names     TEXT,
  author_top_category   TEXT NOT NULL DEFAULT 'other',

  raw_json              TEXT,
  ingested_at           TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id)   REFERENCES guilds(id)   ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_author       ON messages(author_id);
CREATE INDEX IF NOT EXISTS idx_messages_time         ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_guild_cat    ON messages(guild_id, author_top_category);
CREATE INDEX IF NOT EXISTS idx_messages_ref          ON messages(referenced_message_id);

-- ── 📎 Attachments ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  id                TEXT PRIMARY KEY,
  message_id        TEXT NOT NULL,
  filename          TEXT,
  content_type      TEXT,
  size              INTEGER,
  url               TEXT,
  proxy_url         TEXT,
  width             INTEGER,
  height            INTEGER,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- ── 🔔 Mentions ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id        TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- ── 😀 Reactions (aggregate counts, not per-user) ────────────────────────────
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id        TEXT NOT NULL,
  emoji             TEXT NOT NULL,
  count             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, emoji),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- ── 🔎 Full-text search over message content ─────────────────────────────────
-- Stage 2 (Claude → SQL) leans on this heavily. `content=` makes it an
-- external-content table so we don't duplicate every message body.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- ── 📊 Sync run audit trail ──────────────────────────────────────────────────
-- One row per collection run, so you can answer "did last night's run finish,
-- and what did it actually pull?" without reading logs.
CREATE TABLE IF NOT EXISTS sync_runs (
  id                TEXT PRIMARY KEY,
  guild_id          TEXT,
  mode              TEXT NOT NULL,              -- discover | backfill | incremental
  status            TEXT NOT NULL,              -- running | completed | failed | aborted
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at       TEXT,
  channels_seen     INTEGER NOT NULL DEFAULT 0,
  messages_ingested INTEGER NOT NULL DEFAULT 0,
  messages_skipped  INTEGER NOT NULL DEFAULT 0,
  users_seen        INTEGER NOT NULL DEFAULT 0,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);

-- ── 🧾 Schema versioning ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT INTO schema_meta(key, value) VALUES ('version', '1')
  ON CONFLICT(key) DO NOTHING;
