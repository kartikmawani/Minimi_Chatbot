import './env.js';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from './db.js';
import { ENV } from './env.js';
import { logger } from './logger.js';
import { errorHandler, type ErrorCode } from './errors.js';
import { saveMessage, getSessionMessages } from './memory.js';
import { PROMPT_VERSION, runChatAgentStream } from './agent.js';

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

// Messages history endpoint
app.get('/api/messages', (req, res, next) => {
  try {
    const sessionId = (req.query.sessionId as string) || 'default';
    const messages = getSessionMessages(sessionId);
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

const chatRequestSchema = z.object({
  message: z.string().min(1).max(4000),
  sessionId: z.string().min(1).max(100).default('default'),
});

// Chat SSE endpoint with two-phase error handling
app.post('/api/chat', async (req, res, next) => {
  const correlationId = req.correlationId;
  const startTime = Date.now();
  let ttftMs: number | null = null;

  try {
    // Phase 1 (Pre-Stream): Validation
    const parsed = chatRequestSchema.parse(req.body);
    const { message, sessionId } = parsed;

    // Save user message to SQLite
    saveMessage({
      sessionId,
      role: 'user',
      content: message,
    });

    // Set SSE headers and flush
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Phase 2 (Active SSE Stream)
    const reqAbortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        reqAbortController.abort();
      }
    });

    const timeoutSignal = AbortSignal.timeout(25000);
    const combinedSignal = AbortSignal.any([
      reqAbortController.signal,
      timeoutSignal,
    ]);

    const result = await runChatAgentStream({
      userMessage: message,
      sessionId,
      abortSignal: combinedSignal,
    });

    let fullAssistantReply = '';
    const sourcesMap = new Map<string, { title: string; url: string }>();

    for await (const part of result.fullStream) {
      if (part.type === 'tool-call') {
        res.write('data: {"type":"status","message":"Searching the web..."}\n\n');
      } else if (part.type === 'tool-result') {
        const results =
          (part as any).output?.results ??
          (part as any).result?.results ??
          [];
        if (Array.isArray(results)) {
          for (const item of results) {
            if (item && item.url) {
              sourcesMap.set(item.url, {
                title: item.title || item.url,
                url: item.url,
              });
            }
          }
        }
      } else if (part.type === 'text-delta') {
        if (ttftMs === null) {
          ttftMs = Date.now() - startTime;
        }
        const text = (part as any).text ?? (part as any).delta ?? '';
        fullAssistantReply += text;
        res.write(`data: ${JSON.stringify({ type: 'token', text })}\n\n`);
      }
    }

    const usage = await result.usage;
    const finalSources = Array.from(sourcesMap.values());

    // Persist assistant reply + sources + PROMPT_VERSION
    saveMessage({
      sessionId,
      role: 'assistant',
      content: fullAssistantReply,
      sources: finalSources,
      promptVersion: PROMPT_VERSION,
    });

    const latencyMs = Date.now() - startTime;
    logger.info({
      event: 'chat_completed',
      correlationId,
      promptVersion: PROMPT_VERSION,
      model: ENV.MODEL_NAME,
      ttftMs,
      latencyMs,
      tokensIn: (usage as any)?.promptTokens ?? (usage as any)?.inputTokens ?? null,
      tokensOut: (usage as any)?.completionTokens ?? (usage as any)?.outputTokens ?? null,
    });

    res.write(
      `data: ${JSON.stringify({ type: 'sources', sources: finalSources })}\n\n`
    );
    res.write('data: {"type":"done"}\n\n');
    res.end();
  } catch (err: any) {
    if (!res.headersSent) {
      // Phase 1 error: forward to centralized error middleware
      return next(err);
    }

    // Phase 2 error: active SSE stream error
    const isTimeout =
      err?.name === 'TimeoutError' ||
      err?.name === 'AbortError' ||
      err?.message?.includes('timeout') ||
      err?.code === 'ETIMEDOUT';
    const isValidation = err instanceof z.ZodError;
    const errorCode: ErrorCode = isTimeout
      ? 'timeout'
      : isValidation
      ? 'validation_failure'
      : 'provider_error';

    logger.error({
      event: 'chat_stream_error',
      correlationId,
      errorCode,
      message: err?.message ?? 'Stream generation error',
      latencyMs: Date.now() - startTime,
    });

    res.write(
      `data: ${JSON.stringify({
        type: 'error',
        errorCode,
        message: err?.message ?? 'An error occurred during generation.',
      })}\n\n`
    );
    res.end();
  }
});

// Centralized error middleware mounted at the bottom
app.use(errorHandler);

const PORT = 3001;

export const server = app.listen(PORT, () => {
  logger.info({
    event: 'server_listening',
    message: `Backend server listening on port ${PORT}`,
  });
});

export default app;
