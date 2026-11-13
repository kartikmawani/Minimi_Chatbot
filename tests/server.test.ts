import { describe, it, expect, vi, afterAll } from 'vitest';
import { db } from '../server/db.js';
import { AppError, ERROR_STATUS_MAP, errorHandler } from '../server/errors.js';
import { logger, sanitizePayload } from '../server/logger.js';
import { ENV } from '../server/env.js';
import { server } from '../server/index.js';
import { ZodError, z } from 'zod';
import { spawnSync } from 'node:child_process';
import type { Request, Response } from 'express';

afterAll(() => {
  if (server) {
    server.close();
  }
});

describe('server/env.ts', () => {
  it('loads valid environment variables properly', () => {
    expect(ENV.GOOGLE_GENERATIVE_AI_API_KEY).toBe('mock-google-api-key');
    expect(ENV.TAVILY_API_KEY).toBe('mock-tavily-api-key');
    expect(ENV.MODEL_NAME).toBe('gemini-2.5-flash');
    expect(ENV.LOG_RAW_PAYLOADS).toBe(false);
  });

  it('fails loudly with process.exit(1) when required keys are missing in subprocess', () => {
    const result = spawnSync('node', ['--import', 'tsx', 'server/env.ts'], {
      env: {
        PATH: process.env.PATH,
        DOTENV_CONFIG_PATH: 'nonexistent.env',
        // Omit GOOGLE_GENERATIVE_AI_API_KEY and TAVILY_API_KEY
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Environment validation error');
    expect(result.stderr).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
    expect(result.stderr).toContain('TAVILY_API_KEY');
  });
});

describe('server/db.ts', () => {
  it('enables WAL journal mode', () => {
    const mode = db.pragma('journal_mode', { simple: true });
    expect(String(mode).toLowerCase()).toBe('wal');
  });

  it('creates the messages table with all required columns', () => {
    const tableInfo = db.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string;
      type: string;
      pk: number;
    }>;
    const columnNames = tableInfo.map((col) => col.name);

    expect(columnNames).toContain('id');
    expect(columnNames).toContain('session_id');
    expect(columnNames).toContain('role');
    expect(columnNames).toContain('content');
    expect(columnNames).toContain('sources_json');
    expect(columnNames).toContain('prompt_version');
    expect(columnNames).toContain('created_at');
    expect(columnNames).toContain('human_date');
  });

  it('creates the compound index on (session_id, created_at)', () => {
    const indexes = db.prepare("PRAGMA index_list('messages')").all() as Array<{
      name: string;
    }>;
    const indexNames = indexes.map((idx) => idx.name);
    expect(indexNames).toContain('idx_messages_session_created');

    const indexInfo = db.prepare("PRAGMA index_info('idx_messages_session_created')").all() as Array<{
      name: string;
    }>;
    const indexedCols = indexInfo.map((col) => col.name);
    expect(indexedCols).toEqual(['session_id', 'created_at']);
  });

  it('syncs SQLite FTS5 table via AFTER INSERT, AFTER UPDATE, and AFTER DELETE triggers', () => {
    const sessionId = 'test-session-' + Date.now();
    const createdAt = new Date().toISOString();
    const humanDate = 'Today';

    // Insert message
    const insertStmt = db.prepare(`
      INSERT INTO messages (session_id, role, content, sources_json, prompt_version, created_at, human_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertResult = insertStmt.run(
      sessionId,
      'user',
      'Quantum entanglement and cryptographic breakthroughs',
      '[]',
      'v1',
      createdAt,
      humanDate
    );
    const rowId = insertResult.lastInsertRowid;

    // Verify FTS insert
    const ftsSearch1 = db.prepare('SELECT rowid, content FROM messages_fts WHERE messages_fts MATCH ?').all('cryptographic');
    expect(ftsSearch1.some((r: any) => Number(r.rowid) === Number(rowId))).toBe(true);

    // Update message
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(
      'Supercomputing architecture and parallel computation',
      rowId
    );

    // Verify FTS update
    const ftsSearchOld = db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('cryptographic');
    expect(ftsSearchOld.some((r: any) => Number(r.rowid) === Number(rowId))).toBe(false);

    const ftsSearchNew = db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('Supercomputing');
    expect(ftsSearchNew.some((r: any) => Number(r.rowid) === Number(rowId))).toBe(true);

    // Delete message
    db.prepare('DELETE FROM messages WHERE id = ?').run(rowId);

    // Verify FTS delete
    const ftsSearchAfterDel = db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('Supercomputing');
    expect(ftsSearchAfterDel.some((r: any) => Number(r.rowid) === Number(rowId))).toBe(false);
  });
});

describe('server/logger.ts', () => {
  it('redacts sensitive fields like prompt and response when LOG_RAW_PAYLOADS is false', () => {
    const sanitized = sanitizePayload({
      event: 'test_event',
      prompt: 'Secret prompt query',
      response: 'Secret response message',
      nested: {
        content: 'nested content',
        safe: 123,
      },
    });

    expect(sanitized.prompt).toBe('[REDACTED]');
    expect(sanitized.response).toBe('[REDACTED]');
    expect(sanitized.nested.content).toBe('[REDACTED]');
    expect(sanitized.nested.safe).toBe(123);
  });

  it('outputs single-line JSON with all 9 taxonomy fields', () => {
    let capturedLine = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((str) => {
      capturedLine = String(str);
      return true;
    });

    logger.info({
      event: 'test_log_event',
      correlationId: 'cid-123',
      model: 'gemini-2.5-flash',
      latencyMs: 145,
      tokensIn: 20,
      tokensOut: 60,
      errorCode: null,
    });

    writeSpy.mockRestore();

    expect(capturedLine.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(capturedLine.trim());
    expect(parsed).toHaveProperty('timestamp');
    expect(parsed.level).toBe('info');
    expect(parsed.correlationId).toBe('cid-123');
    expect(parsed.event).toBe('test_log_event');
    expect(parsed.model).toBe('gemini-2.5-flash');
    expect(parsed.latencyMs).toBe(145);
    expect(parsed.tokensIn).toBe(20);
    expect(parsed.tokensOut).toBe(60);
    expect(parsed.errorCode).toBe(null);
  });
});

describe('server/errors.ts', () => {
  it('maps error taxonomy codes to HTTP status codes correctly', () => {
    expect(ERROR_STATUS_MAP.bad_request).toBe(400);
    expect(ERROR_STATUS_MAP.validation_failure).toBe(400);
    expect(ERROR_STATUS_MAP.timeout).toBe(504);
    expect(ERROR_STATUS_MAP.provider_error).toBe(502);
    expect(ERROR_STATUS_MAP.internal_error).toBe(500);

    const appErr = new AppError('timeout', 'Request timed out');
    expect(appErr.statusCode).toBe(504);
    expect(appErr.code).toBe('timeout');
  });

  it('centralized error handler catches ZodError (400) without leaking stack', () => {
    const schema = z.object({ query: z.string() });
    let zodError: ZodError | null = null;
    try {
      schema.parse({});
    } catch (e) {
      zodError = e as ZodError;
    }

    let responseStatus = 0;
    let responseBody: any = null;

    const mockRes = {
      status(code: number) {
        responseStatus = code;
        return this;
      },
      json(body: any) {
        responseBody = body;
        return this;
      },
    } as unknown as Response;

    const mockReq = { headers: {} } as unknown as Request;
    const next = vi.fn();

    errorHandler(zodError, mockReq, mockRes, next);

    expect(responseStatus).toBe(400);
    expect(responseBody.error.code).toBe('validation_failure');
    expect(responseBody.error).not.toHaveProperty('stack');
  });

  it('centralized error handler catches AppError cleanly', () => {
    const err = new AppError('provider_error', 'Upstream LLM unavailable');
    let responseStatus = 0;
    let responseBody: any = null;

    const mockRes = {
      status(code: number) {
        responseStatus = code;
        return this;
      },
      json(body: any) {
        responseBody = body;
        return this;
      },
    } as unknown as Response;

    const mockReq = { headers: {} } as unknown as Request;
    const next = vi.fn();

    errorHandler(err, mockReq, mockRes, next);

    expect(responseStatus).toBe(502);
    expect(responseBody.error.code).toBe('provider_error');
    expect(responseBody.error.message).toBe('Upstream LLM unavailable');
    expect(responseBody.error).not.toHaveProperty('stack');
  });

  it('centralized error handler catches generic errors without leaking stack traces', () => {
    const err = new Error('Database disk crashed unexpectedly');
    let responseStatus = 0;
    let responseBody: any = null;

    const mockRes = {
      status(code: number) {
        responseStatus = code;
        return this;
      },
      json(body: any) {
        responseBody = body;
        return this;
      },
    } as unknown as Response;

    const mockReq = { headers: {} } as unknown as Request;
    const next = vi.fn();

    errorHandler(err, mockReq, mockRes, next);

    expect(responseStatus).toBe(500);
    expect(responseBody.error.code).toBe('internal_error');
    expect(responseBody.error.message).toBe('Internal server error');
    expect(responseBody).not.toHaveProperty('stack');
  });
});

describe('server/index.ts GET /api/health', () => {
  it('returns status ok and database connected via HTTP fetch', async () => {
    const res = await fetch('http://localhost:3001/api/health');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.database).toBe('connected');
    expect(json).toHaveProperty('timestamp');

    // Also check x-correlation-id header attached by correlationId middleware
    expect(res.headers.has('x-correlation-id')).toBe(true);
    expect(res.headers.get('x-correlation-id')?.length).toBeGreaterThan(10);
  });
});
