# 🧩 Bittensor Discord Collector — extension

No build step. Load the folder directly:
`chrome://extensions` → Developer mode → **Load unpacked** → pick this folder.

## ⚙️ Changing settings

There is no settings UI. Every value lives in
[`src/shared/config.js`](src/shared/config.js) — edit it and reload the
extension at `chrome://extensions`.

The Settings panel was removed deliberately, not just for tidiness: it wrote
overrides into `chrome.storage` that then silently shadowed the defaults
forever. Editing `config.js` would appear to do nothing, with no indication
why. One source of truth beats an in-browser form.

## 📜 Seeing what it's doing

`chrome://extensions` → this extension → **"service worker"** → Console.

The popup shows one status line and surfaces errors directly. Full detail
belongs in devtools, not a 340px panel.

## 🏗️ How the pieces fit

```
                        ┌──────────────────────┐
                        │  service-worker.js   │  control plane, popup router
                        │  ┌────────────────┐  │
                        │  │  token.js      │──┼──▶ injects into a Discord tab
                        │  │  collector.js  │  │    on demand, reads the token
                        │  │  discord-api   │  │    REST + retry
                        │  │  rate-limiter  │  │    429 / bucket backoff
                        │  │ channel-filter │  │    main / subnet / excluded
                        │  │ ingest-client  │  │    POST + retry
                        │  └────────────────┘  │
                        └──────────┬───────────┘
                                   │ POST /api/ingest
                                   ▼
                        http://127.0.0.1:8787
```

`popup/` only renders state the service worker broadcasts — closing it never
interrupts a run.

## 🔑 Token acquisition

Discord runs `delete window.localStorage` on its own page specifically to stop
scripts reading the auth token. [`token.js`](src/background/token.js) uses the
two documented ways around it, in order:

1. **Same-origin iframe** — a fresh `contentWindow` has an untouched
   `localStorage` bound to the same origin. Fast, and what undiscord uses first.
2. **Webpack module walk** — push a chunk onto `window.webpackChunkdiscord_app`,
   receive the module `require`, and scan its cache for the module exposing
   `default.getToken()`. Slower and more sensitive to Discord releases, but it
   works even if the storage route is closed off.

Both live in one function injected via `chrome.scripting.executeScript` with
`world: 'MAIN'`. The token is passed only to our own service worker and never
persisted.

> **Why not manifest content scripts?** v0.1 declared a MAIN-world script and an
> ISOLATED-world script relaying over `postMessage`. It was two extra files and
> a message protocol, and it failed on any Discord tab that was already open
> when the extension loaded — manifest content scripts only inject on
> navigation, so an existing tab has no listener and the request times out.
> On-demand injection has neither problem.

## 🗑️ Also removed in v0.2

The IndexedDB outbox that parked failed batches for later. It bought nothing:
the server records a per-channel cursor only for batches it actually accepted,
so a failed run already resumes from the last stored position. The outbox added
a database, a flush protocol and a popup affordance to save re-fetching a few
pages. `ingest-client.js` now retries three times and then fails the run loudly.

## 📚 Channel classification

[`channel-filter.js`](src/background/channel-filter.js) sorts every channel into
`main` / `subnet` / `other` / `excluded`. Exclusions are checked first and always
win.

`normalise()` strips emoji, box-drawing characters and fullwidth punctuation
before matching, so `『📢』sn-12・apex` and `sn12-apex` classify identically.

Subnet numbers are extracted by the regexes in
[`config.js`](src/shared/config.js) → `subnetPatterns`, and only accepted inside
`subnetMin`–`subnetMax` (0–128).

**Always run 🔍 Discover first.** It prints every channel, its assigned kind, and
*why* — plus which subnet numbers have no channel at all. Nothing is collected.
Tune the patterns from that output.

The patterns are calibrated against the real server (399 channels). Two things
the first live run taught us, both now covered by tests:

- The dominant shape is `<uid>・<name>・<symbol>` — `12・horde・µ`, `0・rao・🏛`.
- Channel names use lookalike and non-Latin characters freely: `3・τeuτonic・γ`
  (Greek tau for "t"), `65・τpn・ص`, `120・ⴷffine・ⴷ`, `17・404—gen・ρ`. The
  original pattern required an ASCII `[a-z]` after the number and silently
  dropped all five of those subnets.

Deregistered subnets are named `history・daasi・ex-32` and
`_・brain-inactive・ex90` — the `ex` marker is a middle segment, not a prefix,
so matching only `^ex-` missed them.

## ⚠️ Known limitations

Being explicit about what this does *not* collect yet:

- **Threads are not collected.** Neither threads inside text channels nor forum
  posts (channel type 15, where all content lives in threads). The API wrapper
  has `getArchivedThreads()` ready but the collector doesn't walk it. If the
  Bittensor server keeps meaningful discussion in forum channels, this is the
  first thing to add.
- **Roles need a separate pass.** Discord does **not** attach a `member` object
  to messages fetched over REST — only to gateway `MESSAGE_CREATE`/`UPDATE`
  events. Confirmed on the first live run: 0 of 4394 messages carried roles.
  The **🎫 Resolve member roles** button fetches each author's guild profile
  (`GET /users/{id}/profile?guild_id=…`, the same call the Discord client makes
  when you click an avatar) and stamps the result back onto messages already
  stored. One request per user, so budget ~1.2s each; it resumes if stopped and
  does the busiest authors first.
- **A one-off Collect run does not survive a browser restart.** MV3 service
  workers are not durable. The per-channel cursors in SQLite are, so restarting
  resumes rather than starting over. **👁️ Watch mode does survive** — it is
  driven by `chrome.alarms`, which wakes the worker back up, and keeps all its
  state in `chrome.storage` rather than memory.
- **The ingest server must be up before you start.** There is no local buffer
  any more; the run refuses to start if `/api/health` doesn't answer.
- **Reactions are aggregate only** — counts per emoji, not who reacted.

## 👁️ Watch mode

[`watcher.js`](src/background/watcher.js) sweeps every channel that already has
a cursor, pulling anything newer and saving it. Channels never collected are
left alone — watch mode keeps the database *current*, it does not backfill.

It uses `chrome.alarms` rather than `setInterval` for a specific reason: MV3
kills an idle service worker after ~30 seconds. A sweep keeps the worker alive
because it is continuously awaiting fetches, but the gap between sweeps would
not, and a `setInterval` would simply never fire again. Alarms wake the worker
back up.

That has a consequence worth understanding: **the watcher holds no state in
memory.** Whether it is running, which guild, how many sweeps have happened —
all in `chrome.storage`, and the Discord token is re-acquired every wake. A
sweep that finds the server down or the token unreadable logs it and waits for
the next one rather than tearing down a watch you set up hours ago.

Default interval is 15 minutes. A sweep costs roughly `channels × requestDelayMs`
— about 5 minutes for this server — so shorter intervals leave almost no idle
time and hammer the API continuously.

## 🐌 Pacing

Default `requestDelayMs: 1200` is roughly 0.8 req/s against a documented global
limit near 50 req/s. At 100 messages per request that is still ~83 messages a
second. Lowering it is the main thing that gets accounts flagged; the three
backoff layers are in [`rate-limiter.js`](src/background/rate-limiter.js).
