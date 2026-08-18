/**
 * 📡 Ingest client — talks to the local server.
 *
 * Deliberately simple: POST, retry a few times on transient failure, then give
 * up and let the run fail loudly.
 *
 * An earlier version parked failed batches in an IndexedDB outbox so a run
 * could survive the server being down. That turned out to buy nothing: the
 * server records a per-channel cursor only for batches it actually accepted, so
 * a failed run resumes from the last *stored* position anyway. The outbox added
 * a database, a flush protocol and a UI affordance to save re-fetching a few
 * pages. Removed.
 */
import { createLogger } from '../shared/logger.js';
import { EMOJI } from '../shared/constants.js';

const log = createLogger('ingest');

const MAX_RETRIES = 3;

export class IngestClient {
  /**
   * @param {object} opts
   * @param {string} opts.serverUrl
   * @param {string} opts.ingestKey  '' disables the header
   */
  constructor({ serverUrl, ingestKey }) {
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.ingestKey = ingestKey;
    this.stats = { sent: 0, inserted: 0, duplicates: 0 };
  }

  get headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.ingestKey) headers['X-Ingest-Key'] = this.ingestKey;
    return headers;
  }

  /** ✅ Is the ingest server reachable? Never throws. */
  async ping() {
    try {
      const response = await fetch(`${this.serverUrl}/api/health`);
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      return { ok: true, ...(await response.json()) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * ♻️ Which of these message IDs are already in the database?
   *
   * Used to avoid re-storing — and, more importantly, to stop paging a channel
   * once we reach messages we already have. Returns a Set for O(1) lookup.
   * On any failure returns an empty Set, so a hiccup degrades to "store it
   * again" (harmless, the server deduplicates) rather than losing data.
   */
  async known(ids) {
    if (!ids.length) return new Set();
    try {
      const { known } = await this.post('/api/messages/known', { ids });
      return new Set(known);
    } catch (err) {
      log.event(EMOJI.warn, 'debug', 'known-check failed, assuming none', { error: err.message });
      return new Set();
    }
  }

  /** 🗄️ How many messages the database holds for this guild. */
  async totals(guildId) {
    try {
      const response = await fetch(`${this.serverUrl}/api/totals/${guildId}`, {
        headers: this.headers,
      });
      if (!response.ok) return null;
      return (await response.json()).totals ?? null;
    } catch {
      return null;
    }
  }

  /** 📈 Per-channel resume state, so a re-run doesn't re-fetch what we have. */
  async getResumeState(guildId) {
    try {
      const response = await fetch(`${this.serverUrl}/api/resume/${guildId}`, {
        headers: this.headers,
      });
      if (!response.ok) return null;
      return (await response.json()).channels ?? null;
    } catch {
      return null;
    }
  }

  async startRun(runId, guildId, mode) {
    await this.post('/api/run/start', { runId, guildId, mode }).catch(() => {});
  }

  async finishRun(runId, status, error) {
    await this.post('/api/run/finish', { runId, status, error }).catch(() => {});
  }

  /** One POST. Throws on any non-2xx. */
  async post(path, body) {
    const response = await fetch(`${this.serverUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  /**
   * Send a batch, retrying transient failures with backoff.
   * Throws once the retry budget is spent — the collector turns that into a
   * failed run rather than silently dropping data.
   */
  async send(batch) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { result } = await this.post('/api/ingest', batch);
        this.stats.sent++;
        this.stats.inserted += result?.messagesInserted ?? 0;
        this.stats.duplicates += result?.messagesSkipped ?? 0;

        log.event(EMOJI.saved, 'debug', 'batch accepted', {
          new: result?.messagesInserted,
          dup: result?.messagesSkipped,
        });
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          const backoff = 1000 * 2 ** attempt;
          log.event(EMOJI.warn, 'warn', 'ingest failed, retrying', {
            attempt,
            backoffMs: backoff,
            error: err.message,
          });
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    throw new Error(
      `Ingest server unreachable after ${MAX_RETRIES} attempts (${lastError?.message}). ` +
        `Is it running at ${this.serverUrl}? Progress up to this point is saved — restarting resumes.`,
    );
  }

  snapshot() {
    return { ...this.stats };
  }
}
