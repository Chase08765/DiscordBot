/**
 * ⚙️ Environment configuration.
 *
 * Every environment-dependent value in the server flows through this module.
 * Nothing else in the codebase is allowed to read `process.env` directly — that
 * way the full surface of "things you can configure" is one file, and a typo in
 * a `.env` fails loudly at boot instead of silently at 3am.
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** server/ — two levels up from src/config/ */
export const SERVER_ROOT = path.resolve(HERE, '..', '..');

loadDotenv({ path: path.join(SERVER_ROOT, '.env') });

/** Accepts `true/1/yes/on` (case-insensitive) as true, anything else false. */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : /^(true|1|yes|on)$/i.test(v)));

const intish = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  PORT: intish(8787),
  HOST: z.string().default('127.0.0.1'),
  INGEST_KEY: z.string().default(''),
  CORS_ORIGINS: z.string().default(''),

  DATABASE_PATH: z.string().default('./data/discord.db'),
  DATABASE_WAL: boolish(true),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_EMOJI: boolish(true),
  LOG_TO_FILE: boolish(true),
  LOG_DIR: z.string().default('./logs'),

  MAX_BATCH_MESSAGES: intish(1000),
  MAX_BODY_SIZE: z.string().default('25mb'),
  STORE_RAW_JSON: boolish(true),

  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-sonnet-5'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // We cannot use the logger here — it depends on this module.
  console.error('❌ [config] Invalid environment configuration:\n');
  for (const issue of parsed.error.issues) {
    console.error(`   • ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  console.error('\n   Copy .env.example to .env and fix the values above.\n');
  process.exit(1);
}

const raw = parsed.data;

/** Resolve a possibly-relative path from the .env against the server root. */
const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.resolve(SERVER_ROOT, p));

export const env = {
  nodeEnv: raw.NODE_ENV,
  isDev: raw.NODE_ENV === 'development',
  isProd: raw.NODE_ENV === 'production',

  http: {
    port: raw.PORT,
    host: raw.HOST,
    /** Empty string means "auth disabled". */
    ingestKey: raw.INGEST_KEY,
    corsOrigins: raw.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxBodySize: raw.MAX_BODY_SIZE,
  },

  db: {
    path: resolvePath(raw.DATABASE_PATH),
    wal: raw.DATABASE_WAL,
  },

  log: {
    level: raw.LOG_LEVEL,
    emoji: raw.LOG_EMOJI,
    toFile: raw.LOG_TO_FILE,
    dir: resolvePath(raw.LOG_DIR),
  },

  ingest: {
    maxBatchMessages: raw.MAX_BATCH_MESSAGES,
    storeRawJson: raw.STORE_RAW_JSON,
  },

  claude: {
    apiKey: raw.ANTHROPIC_API_KEY ?? '',
    model: raw.CLAUDE_MODEL,
  },
} as const;

export type Env = typeof env;
