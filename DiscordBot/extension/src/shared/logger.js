/**
 * 📜 Logger.
 *
 * Console only. Open it with: chrome://extensions → this extension →
 * "service worker" → Console.
 *
 * The popup used to mirror every line into a Log tab backed by a ring buffer in
 * chrome.storage.session. That is gone — the popup now shows one status line
 * and surfaces errors directly, which is what you actually need while a run is
 * going. Full detail belongs in devtools, not in a 340px panel.
 */
import { EMOJI } from './constants.js';

const LEVEL_RANK = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const LEVEL_EMOJI = { trace: '🔬', debug: '🔧', info: 'ℹ️', warn: EMOJI.warn, error: EMOJI.error };

let minRank = LEVEL_RANK.info;

export function setLogLevel(level) {
  minRank = LEVEL_RANK[level] ?? LEVEL_RANK.info;
}

function emit(emoji, level, scope, message, fields) {
  if (LEVEL_RANK[level] < minRank) return;

  const suffix = fields
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')
    : '';
  const line = `${emoji || LEVEL_EMOJI[level]} [${scope}] ${message}${suffix}`;

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function fmt(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return /\s/.test(s) ? JSON.stringify(s) : s;
}

export function createLogger(scope) {
  return {
    trace: (m, f) => emit(null, 'trace', scope, m, f),
    debug: (m, f) => emit(null, 'debug', scope, m, f),
    info: (m, f) => emit(null, 'info', scope, m, f),
    warn: (m, f) => emit(null, 'warn', scope, m, f),
    error: (m, f) => emit(null, 'error', scope, m, f),
    /** Explicit emoji, e.g. `log.event(EMOJI.fetched, 'info', 'page', {...})`. */
    event: (emoji, level, m, f) => emit(emoji, level, scope, m, f),
  };
}
