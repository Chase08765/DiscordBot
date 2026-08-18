/**
 * 📜 Structured, emoji-prefixed logger.
 *
 * Design goals:
 *   • A human watching `npm run dev` can follow a collection run at a glance.
 *   • Every line is still greppable: `TIME LEVEL [scope] message key=value …`
 *   • Zero dependencies, so it can boot before anything else is wired up.
 *
 * Usage:
 *   const log = createLogger('db');
 *   log.info('opened', { path: '/data/discord.db' });
 *   log.event('💾', 'info', 'persisted batch', { messages: 100 });
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

/** Default emoji when a call site doesn't pick a more specific one. */
const LEVEL_EMOJI: Record<LogLevel, string> = {
  trace: '🔬',
  debug: '🔧',
  info: 'ℹ️ ',
  warn: '⚠️ ',
  error: '❌',
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: '\x1b[90m', // grey
  debug: '\x1b[36m', // cyan
  info: '\x1b[37m', // white
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

/** Scope-name padding so the `[scope]` column lines up in the terminal. */
const SCOPE_WIDTH = 9;

const minRank = LEVEL_RANK[env.log.level];
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

// ── file sink ────────────────────────────────────────────────────────────────

let fileStream: fs.WriteStream | null = null;
let fileStreamDate = '';
/** Local mirror of env.log.toFile so a failed open can switch it off. */
let fileLoggingEnabled = env.log.toFile;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Lazily open (and daily-rotate) the log file. Failures degrade to stdout-only. */
function getFileStream(): fs.WriteStream | null {
  if (!fileLoggingEnabled) return null;
  const date = today();
  if (fileStream && fileStreamDate === date) return fileStream;

  try {
    fs.mkdirSync(env.log.dir, { recursive: true });
    fileStream?.end();
    fileStream = fs.createWriteStream(path.join(env.log.dir, `server-${date}.log`), {
      flags: 'a',
    });
    fileStreamDate = date;
    return fileStream;
  } catch {
    // Disable file logging for the rest of the process rather than throwing on
    // every single log line.
    fileLoggingEnabled = false;
    return null;
  }
}

// ── formatting ───────────────────────────────────────────────────────────────

export type LogFields = Record<string, unknown>;

/** Render `{ a: 1, b: 'x y' }` → `a=1 b="x y"` */
function formatFields(fields?: LogFields): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return JSON.stringify(`${value.name}: ${value.message}`);
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  return /[\s"]/.test(s) ? JSON.stringify(s) : s;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

// ── logger ───────────────────────────────────────────────────────────────────

export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Log with an explicit emoji, e.g. `log.event('💾', 'info', 'saved', {...})`. */
  event(emoji: string, level: LogLevel, msg: string, fields?: LogFields): void;
  /** Derive a nested scope: `db` → `db:messages`. */
  child(subScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  const emit = (emoji: string, level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVEL_RANK[level] < minRank) return;

    const prefix = env.log.emoji ? `${emoji} ` : '';
    const paddedScope = `[${scope}]`.padEnd(SCOPE_WIDTH + 2);
    const fieldStr = formatFields(fields);

    // Plain line for the file sink.
    const plain = `${timestamp()} ${level.toUpperCase().padEnd(5)} ${prefix}${paddedScope} ${msg}${fieldStr}`;
    getFileStream()?.write(plain + '\n');

    // Coloured line for the terminal.
    const line = useColor
      ? `${DIM}${timestamp()}${RESET} ${LEVEL_COLOR[level]}${prefix}${paddedScope}${RESET} ${msg}${DIM}${fieldStr}${RESET}`
      : plain;

    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };

  return {
    trace: (m, f) => emit(LEVEL_EMOJI.trace, 'trace', m, f),
    debug: (m, f) => emit(LEVEL_EMOJI.debug, 'debug', m, f),
    info: (m, f) => emit(LEVEL_EMOJI.info, 'info', m, f),
    warn: (m, f) => emit(LEVEL_EMOJI.warn, 'warn', m, f),
    error: (m, f) => emit(LEVEL_EMOJI.error, 'error', m, f),
    event: (e, l, m, f) => emit(e, l, m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/** Shared emoji vocabulary — keep in sync with the table in the README. */
export const EMOJI = {
  startup: '🚀',
  config: '⚙️ ',
  db: '🗄️ ',
  extension: '🧩',
  auth: '🔑',
  discover: '🔍',
  network: '📡',
  channel: '📚',
  fetched: '📥',
  saved: '💾',
  skipped: '⏭️ ',
  throttled: '🐌',
  paused: '⏸️ ',
  done: '✅',
  stats: '📊',
  user: '👤',
  role: '🎭',
  clean: '🧹',
} as const;
