/**
 * 🔑 Token acquisition.
 *
 * Discord runs `delete window.localStorage` on its own page specifically to
 * stop scripts reading the auth token. Two known ways around it, tried in
 * order:
 *
 *   1. IFRAME  — a same-origin <iframe> has a fresh, untouched `localStorage`
 *      bound to the same origin. This is what undiscord uses first.
 *   2. WEBPACK — push a chunk onto `window.webpackChunkdiscord_app`, receive
 *      the module `require`, and scan its cache for the module exposing
 *      `default.getToken()`.
 *
 * The whole thing is ONE injected function. An earlier version used a pair of
 * manifest content scripts (MAIN world + ISOLATED world) talking over
 * postMessage; that was more code and it silently failed on any Discord tab
 * that was already open when the extension loaded, because manifest content
 * scripts only inject on navigation.
 *
 * `chrome.scripting.executeScript` injects on demand, so an already-open tab
 * works with no reload.
 */
import { EMOJI } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('token');

/**
 * Runs inside the Discord page, in Discord's own JS context.
 *
 * ⚠️ Must be entirely self-contained — Chrome serialises this function to
 * inject it, so it cannot reference anything from module scope.
 *
 * Returns diagnostics alongside the token so a failure says *why*.
 */
function grabTokenInPage() {
  const tried = [];

  // ── 1. Same-origin iframe ─────────────────────────────────────────────────
  let iframe;
  try {
    iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    document.body.appendChild(iframe);

    const raw = iframe.contentWindow.localStorage.getItem('token');
    if (raw) {
      // Discord stores it JSON-encoded, i.e. including the quotes.
      return { token: JSON.parse(raw), method: 'iframe', tried };
    }
    tried.push('iframe: localStorage has no "token" key (not logged in?)');
  } catch (err) {
    tried.push(`iframe: ${err.message}`);
  } finally {
    iframe?.remove();
  }

  // ── 2. Webpack module cache ───────────────────────────────────────────────
  try {
    if (!window.webpackChunkdiscord_app) {
      tried.push('webpack: window.webpackChunkdiscord_app is missing (not the Discord app?)');
    } else {
      let found = null;
      window.webpackChunkdiscord_app.push([
        [`btcollector_${Math.random().toString(36).slice(2)}`],
        {},
        (require) => {
          for (const key in require.c) {
            const getToken = require.c[key]?.exports?.default?.getToken;
            if (typeof getToken !== 'function') continue;
            try {
              const value = getToken();
              if (typeof value === 'string' && value.length > 20) {
                found = value;
                return;
              }
            } catch {
              /* module threw; keep looking */
            }
          }
        },
      ]);

      if (found) return { token: found, method: 'webpack', tried };
      tried.push('webpack: no module exposed a usable getToken()');
    }
  } catch (err) {
    tried.push(`webpack: ${err.message}`);
  }

  return { token: null, method: 'none', tried };
}

/** Pull the guild ID out of a /channels/<guildId>/<channelId> URL. */
function guildIdFromUrl(url) {
  const match = /^https:\/\/discord\.com\/channels\/(\d{5,25})/.exec(url ?? '');
  return match ? match[1] : null;
}

/**
 * Find a logged-in Discord tab and read its token.
 *
 * @returns {Promise<{ token: string, guildId: string|null, tabId: number }>}
 * @throws  {Error} with a message naming what was actually tried
 */
export async function acquireToken() {
  const tabs = await chrome.tabs.query({ url: 'https://discord.com/*' });

  if (!tabs.length) {
    throw new Error('No Discord tab is open. Open https://discord.com/channels/@me and log in.');
  }

  // Prefer a tab already viewing a guild — that URL also gives us the guild ID.
  const ordered = [...tabs].sort(
    (a, b) => (guildIdFromUrl(a.url) ? 0 : 1) - (guildIdFromUrl(b.url) ? 0 : 1),
  );

  const diagnostics = [];

  for (const tab of ordered) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: grabTokenInPage,
      });

      const result = injection?.result;
      if (result?.token) {
        const guildId = guildIdFromUrl(tab.url);
        log.event(EMOJI.auth, 'info', 'token acquired', {
          method: result.method,
          guildInUrl: guildId ?? '—',
        });
        return { token: result.token, guildId, tabId: tab.id };
      }

      diagnostics.push(`tab ${tab.id}: ${(result?.tried ?? ['no result']).join('; ')}`);
    } catch (err) {
      // Usually a tab we can't inject into (chrome:// redirect, discarded tab).
      diagnostics.push(`tab ${tab.id}: injection failed — ${err.message}`);
    }
  }

  log.event(EMOJI.error, 'error', 'token acquisition failed', { tabs: tabs.length });
  for (const line of diagnostics) log.event(EMOJI.error, 'error', `   ${line}`);

  throw new Error(
    `Could not read the Discord token from ${tabs.length} tab(s). ` +
      `Check the Log tab for what each attempt reported. ` +
      `Most likely: you are not logged in, or the tab is on a Discord marketing page rather than the app.`,
  );
}
