/** 🚀 Server entry point. */
import { env } from './config/env.js';
import { createLogger, EMOJI } from './core/logger.js';
import { closeDb, getDb } from './db/client.js';
import { messagesRepo } from './db/repositories/messages.repo.js';
import { createServer } from './http/server.js';

const log = createLogger('server');

function main(): void {
  log.event(EMOJI.startup, 'info', 'Bittensor Discord ingest server starting…');
  log.event(EMOJI.config, 'info', 'env loaded', {
    env: env.nodeEnv,
    port: env.http.port,
    logLevel: env.log.level,
    auth: env.http.ingestKey ? 'enabled' : 'disabled',
  });

  getDb(); // opens + applies schema, logging as it goes

  const totals = messagesRepo.totals();
  log.event(EMOJI.stats, 'info', 'existing data', totals);

  const server = createServer().listen(env.http.port, env.http.host, () => {
    log.event(EMOJI.done, 'info', 'listening', {
      url: `http://${env.http.host}:${env.http.port}`,
    });
    log.info('waiting for the extension to connect…');
  });

  const shutdown = (signal: string) => {
    log.event(EMOJI.paused, 'info', 'shutting down', { signal });
    server.close(() => {
      closeDb();
      log.event(EMOJI.done, 'info', 'bye 👋');
      process.exit(0);
    });
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { error: err });
    console.error(err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: String(reason) });
  });
}

main();
