/** 🌐 Cross-cutting HTTP concerns: request logging, auth, error handling. */
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { createLogger, EMOJI } from '../core/logger.js';

const log = createLogger('http');

/** 📡 One line per request, with duration and status. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const emoji = res.statusCode >= 500 ? '❌' : res.statusCode >= 400 ? '⚠️ ' : EMOJI.network;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    log.event(emoji, level, `${req.method} ${req.path}`, { status: res.statusCode, ms });
  });
  next();
}

/**
 * 🔑 Shared-secret check for write endpoints.
 * Disabled entirely when INGEST_KEY is empty (the local-dev default).
 */
export function requireIngestKey(req: Request, res: Response, next: NextFunction): void {
  if (!env.http.ingestKey) return next();

  const provided = req.header('x-ingest-key');
  if (provided !== env.http.ingestKey) {
    log.event(EMOJI.auth, 'warn', 'rejected: bad ingest key', { ip: req.ip });
    res.status(401).json({ ok: false, error: 'invalid or missing X-Ingest-Key' });
    return;
  }
  next();
}

/** ❌ Terminal error handler. Never leaks stack traces in production. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error('unhandled request error', { error: message });
  if (env.isDev && err instanceof Error) console.error(err.stack);

  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: env.isDev ? message : 'internal error' });
}

/**
 * CORS origin check. Any `chrome-extension://` origin is allowed, because the
 * extension ID changes every time it is reloaded unpacked and pinning it would
 * mean editing .env after every reload.
 */
export function corsOriginCheck(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) return callback(null, true); // curl, same-origin, service worker
  if (origin.startsWith('chrome-extension://')) return callback(null, true);
  if (env.http.corsOrigins.includes(origin)) return callback(null, true);
  callback(new Error(`origin not allowed: ${origin}`));
}
