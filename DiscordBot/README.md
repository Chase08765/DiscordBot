# 🤖 Bittensor Discord Knowledge Bot

A three-stage pipeline that turns the Bittensor Discord server into a queryable
knowledge base.

```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  1. COLLECT      │      │  2. QUERY GEN    │      │  3. ANSWER GEN   │
│                  │ ───▶ │                  │ ───▶ │                  │
│ Chrome extension │      │ Claude turns a   │      │ Claude answers   │
│ harvests Discord │      │ question into    │      │ from the rows    │
│ → SQLite         │      │ SQL over the DB  │      │ that came back   │
└──────────────────┘      └──────────────────┘      └──────────────────┘
     ✅ STAGE 1                 ⏳ later                  ⏳ later
```

**This repo currently implements Stage 1 only.** Stages 2 and 3 come after we
verify the collected data looks right.

---

## 📁 Layout

```
DiscordBot/
├── extension/          🧩 Chrome MV3 extension — no build step, load unpacked
│   ├── manifest.json
│   └── src/
│       ├── background/     the collector engine (service worker)
│       ├── content/        token acquisition bridge
│       ├── popup/          control panel + live log
│       └── shared/         config, logger, constants
│
└── server/             🗄️  Node + TypeScript ingest API → SQLite
    ├── src/
    │   ├── config/         env loading & validation
    │   ├── core/           logger
    │   ├── db/             schema, client, repositories
    │   ├── http/           routes & middleware
    │   └── ingest/         payload validation + persistence
    └── data/               discord.db lands here (gitignored)
```

Two halves talk over one HTTP endpoint: `POST /api/ingest`. The extension
buffers everything in IndexedDB first, so **collection never stalls if the
server is down** — it just flushes later.

---

## 🚀 Quick start

### 0. Prerequisites

Node.js **v24.19.0 is installed** (via `winget install OpenJS.NodeJS.LTS`).
Open a new terminal if `node --version` isn't found — PATH needs to refresh.

> **Why better-sqlite3 v13 specifically:** v11 has no prebuilt binary for
> Node 24, so npm falls back to compiling it with node-gyp, which needs Python
> and MSVC build tools. v13 ships a Node 24 prebuild — no toolchain required.
> Don't downgrade it.

### 1. Start the ingest server

**Double-click `start-server.bat`** in the project root. It creates `.env`,
installs dependencies on first run, and starts the server. Leave the window open
while collecting; close it when done.

Or by hand:

```powershell
cd server
Copy-Item .env.example .env
npm install
npm approve-scripts esbuild   # npm 11+ gates postinstall scripts; tsx needs it
npm run dev
```

> **Why a server at all?** Collection alone could write straight from the
> browser, but stages 2 and 3 cannot: an Anthropic API key in a Chrome extension
> is extractable by anyone who has the extension, and "Claude writes SQL, we run
> it" needs a real SQL engine. Since the backend is required either way, stage 1
> uses it too rather than building a second data path we'd throw away.

You should see (this is real output, not an illustration):

```
🚀 [server]    Bittensor Discord ingest server starting…
⚙️  [server]    env loaded env=development port=8787 logLevel=info auth=disabled
🗄️  [db]        opened path=C:\Work\DiscordBot\server\data\discord.db
🗄️  [db]        schema applied tables=17
📊 [server]    existing data messages=0 users=0 channels=0 guilds=0
✅ [server]    listening url=http://127.0.0.1:8787
ℹ️  [server]    waiting for the extension to connect…
```

### 1b. Verify it end to end

```powershell
npm run smoke      # 27 checks against the running server
```

This POSTs a realistic Discord payload and asserts it comes back out correctly —
role resolution, the moderator-beats-subnet-owner ranking, idempotent replay,
channel classification, resume cursors, FTS search, and the run audit trail.
Run it after any change to the ingest path.

```powershell
cd ..\extension
npm test           # 9 tests over the channel classifier
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `c:\Work\DiscordBot\extension`
4. Open <https://discord.com/channels/@me> and log in
5. Navigate to the **Bittensor server** so the guild ID is in the URL
6. Click the extension icon

### 3. The three buttons, in order

| | What it does |
|---|---|
| **🔍 Discover** | Lists every channel and how it was classified. Saves no messages. |
| **▶️ Collect** | Harvests history back to `backfillSinceIso` (default **2026-01-01**). |
| **🎫 Resolve member roles** | Fetches each author's roles and stamps them onto messages already stored. |
| **👁️ Watch for new** | Runs in the background on a timer, saving new messages as they appear. |

### 🔢 What the counters mean

The popup's headline number is **messages in the database**, queried live from
the server on every refresh. Deliberately not a run counter: a tally kept in the
service worker reads 0 whenever the worker restarted or the popup was opened
fresh — precisely when you most want the number. Underneath it: channels with
messages, members whose roles are resolved, and new rows written this run.

`members` counts resolved roles, not people who have posted. It reads 0 until
🎫 Resolve member roles has run, which is the honest signal that role data is
still missing.

There is **no settings UI** — every value lives in
`extension/src/shared/config.js`. Edit it and reload the extension.

### ♻️ Nothing is stored twice

Three independent layers, so a duplicate cannot survive any of them:

1. **Before sending** — each page's IDs are checked against the database
   (`POST /api/messages/known`), and known ones are dropped.
2. **On write** — every insert is `ON CONFLICT DO NOTHING`, so even a race
   between two runs cannot double-write.
3. **Stop early** — three consecutive fully-known pages means the backfill has
   walked into territory a previous run already covered, so it moves on to the
   next channel instead of paging through history it would only discard. This
   is the one that saves real time: the expensive resource is Discord requests,
   not disk.

Step 3 is separate because **Discord does not send roles with messages.** The
`member` object only exists on gateway events, never on REST message fetches —
confirmed at 0/4394 on the first live run. Roles therefore have to be fetched
per author afterwards, one request each.

Useful maintenance commands:

```powershell
npm run db:stats             # collection report
npm run db:reclassify -- --dry   # preview role re-classification
npm run db:reclassify        # re-apply it to stored roles, no re-fetching
```

### 4. Calibrate before you harvest

Channel naming in the Bittensor server is not guessable from the outside, so
the popup has a **🔍 Discover** button. It lists every channel it can see,
along with how the filter classified it (`main` / `subnet N` / `excluded` /
`other`), and writes nothing to the database.

Look at that list, then adjust the patterns in
`extension/src/shared/config.js` if anything is misclassified. Only then hit
**▶️ Start collection**.

---

## ⚠️ Read this before running

Using a personal account token to automate reads is against Discord's Terms of
Service (it's "self-botting"), regardless of intent. The sanctioned path is a
bot token via the official API, which requires the server admins to invite your
application.

Practical mitigations baked in, since you're going the extension route anyway:

- Conservative default pacing (`REQUEST_DELAY_MS = 1200`) — well under the
  documented 50 req/s global limit.
- Full `429` handling with `retry_after`, plus proactive backoff from
  `X-RateLimit-Remaining` / `X-RateLimit-Reset-After` headers.
- Global rate-limit detection (`{"global": true}`) triggers a hard pause.
- Read-only. The collector has no code path that writes to Discord.

## 📜 Logging

Both halves log with a consistent emoji-prefixed format so you can follow a run
in real time:

| Emoji | Meaning        | Emoji | Meaning              |
|-------|----------------|-------|----------------------|
| 🚀    | startup        | 📥    | fetched a page       |
| ⚙️     | config         | 💾    | persisted to DB      |
| 🗄️     | database       | ⏭️     | skipped              |
| 🧩    | extension      | 🐌    | rate limited         |
| 🔑    | auth / token   | ⏸️     | paused               |
| 🔍    | discovery      | ⚠️     | warning              |
| 📡    | network        | ❌    | error                |
| 📚    | channel work   | ✅    | success              |

Server logs stream to stdout and append to `server/logs/server-YYYY-MM-DD.log`.
Extension logs stream to the popup and the service worker console.

---

## ✅ Verification status

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `npm run smoke` (server) | 41/41 |
| `npm test` (server, role classifier) | 10/10 |
| `npm test` (extension, channel classifier) | 18/18 |
| better-sqlite3 v13 on Node 24 | prebuilt binary, FTS5 present, SQLite 3.53.4 |

**Verified against real data.** A live run collected 4394 messages, 399
channels and 207 roles from the Bittensor server. The classifiers are calibrated
against those actual names, and the awkward cases are pinned down by tests.

**Still unverified: the role enrichment endpoint.** `GET /users/{id}/profile?guild_id=…`
is what the Discord client calls when you click an avatar, so it should work
with a user session, but it has not been exercised yet. If it 403s, the run
logs it per user and continues rather than dying.

## 🔜 Next

1. Re-run **🔍 Discover** — the channel patterns changed, so the 5 mislabelled
   subnets (3, 4, 17, 65, 120) need re-classifying.
2. **▶️ Collect** with the 2026-01-01 horizon.
3. **🎫 Resolve member roles** — the first real test of the profile endpoint.
4. Then stage 2 (Claude → SQL) on top of the data.
