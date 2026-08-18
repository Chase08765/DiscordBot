/** 🌐 Express app assembly. */
import express, { type Express } from 'express';
import cors from 'cors';
import { env } from '../config/env.js';
import { corsOriginCheck, errorHandler, requestLogger } from './middleware.js';
import { ingestRouter } from './routes/ingest.routes.js';
import { statsRouter } from './routes/stats.routes.js';

export function createServer(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ origin: corsOriginCheck, allowedHeaders: ['Content-Type', 'X-Ingest-Key'] }));
  app.use(express.json({ limit: env.http.maxBodySize }));
  app.use(requestLogger);

  app.use('/api', statsRouter);
  app.use('/api', ingestRouter);

  app.get('/', (_req, res) => {
    res.type('text/plain').send(
      [
        '🤖 Bittensor Discord ingest server',
        '',
        'GET  /api/health              liveness',
        'GET  /api/stats               collection summary',
        'GET  /api/channels?guild=ID   channel inventory + classification',
        'GET  /api/search?q=…          full-text search sanity check',
        'GET  /api/resume/:guildId     per-channel resume state',
        'POST /api/ingest              submit a batch',
        'POST /api/run/start           open a run',
        'POST /api/run/finish          close a run',
      ].join('\n'),
    );
  });

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }));
  app.use(errorHandler);

  return app;
}
