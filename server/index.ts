import './env.js';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { db } from './db.js';
import { logger } from './logger.js';
import { errorHandler } from './errors.js';

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

export const app: express.Express = express();

app.use(cors());
app.use(express.json());

// Correlation ID middleware
app.use((req, res, next) => {
  const correlationId =
    (req.headers['x-correlation-id'] as string) || crypto.randomUUID();
  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);
  next();
});

// Health check endpoint
app.get('/api/health', (req, res, next) => {
  try {
    const row = db.prepare('SELECT 1 as healthy').get();
    res.json({
      status: 'ok',
      database: row ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// Centralized error middleware
app.use(errorHandler);

const PORT = 3001;

export const server = app.listen(PORT, () => {
  logger.info({
    event: 'server_listening',
    message: `Backend server listening on port ${PORT}`,
  });
});

export default app;
