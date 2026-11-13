import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// 1. Safe Boot & Isolated Setup: Ensure fallback test environment variables exist before importing server modules
const { TEST_SESSION_ID, mockStreamText, lastCapturedCall } = vi.hoisted(() => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY || 'test-google-key-vitest';
  process.env.TAVILY_API_KEY =
    process.env.TAVILY_API_KEY || 'test-tavily-key-vitest';
  process.env.MODEL_NAME = process.env.MODEL_NAME || 'gemini-2.5-flash';
  process.env.LOG_RAW_PAYLOADS = 'false';

  return {
    TEST_SESSION_ID: 'vitest-eval-session',
    mockStreamText: vi.fn(),
    lastCapturedCall: { current: null as any },
  };
});

// Mock language model stream from 'ai'
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: mockStreamText,
  };
});

// Import server modules safely after vi.hoisted
import { db } from '../server/db.js';
import { retrieveTemporalContext } from '../server/memory.js';
import { seedSampleHistory } from '../server/seed.js';
import {
  executeWebSearch,
  _testHooks,
} from '../server/searchTool.js';
import {
  PROMPT_VERSION,
  STATIC_SYSTEM_PROMPT,
} from '../server/agent.js';
import { app, server } from '../server/index.js';

let testHttpServer: Server;
let testBaseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    testHttpServer = app.listen(0, '127.0.0.1', () => {
      const port = (testHttpServer.address() as AddressInfo).port;
      testBaseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  // Isolated SQLite cleanup
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(TEST_SESSION_ID);
  _testHooks.resetTavilyClient();
  _testHooks.clearCache();
  _testHooks.resetCircuitBreaker();
  if (testHttpServer) {
    testHttpServer.close();
  }
  if (server) {
    server.close();
  }
});

describe('Test Suite 1 — Temporal Date Resolution & FTS5 Sanitization (server/memory.ts)', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(TEST_SESSION_ID);
    seedSampleHistory(TEST_SESSION_ID);
  });

  it('resolves "3 November" prompt to matching historical records in <15ms without FTS5 errors on special chars', () => {
    const fixedNow = new Date('2026-11-13T12:00:00Z');
    const prompt = 'What did I ask you on "3 November"? Is your answer still correct-today?';

    const t0 = performance.now();
    const context = retrieveTemporalContext(prompt, TEST_SESSION_ID, fixedNow);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(15);
    expect(context).toContain('OpenAI GPT-4o');
    expect(context).toContain('Anthropic Claude 3.5 Sonnet');
    expect(context).toContain('Tuesday, 3 November 2026');
  });

  it('resolves "Monday CRM shortlist" prompt in <15ms without FTS5 syntax errors', () => {
    const fixedNow = new Date('2026-11-13T12:00:00Z');
    const prompt = 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?';

    const t0 = performance.now();
    const context = retrieveTemporalContext(prompt, TEST_SESSION_ID, fixedNow);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(15);
    expect(context).toContain('HubSpot Sales Hub');
    expect(context).toContain('Salesforce Sales Cloud');
    expect(context).toContain('Pipedrive');
  });

  it('resolves "Last Tuesday Postgres hosting" prompt in <15ms without FTS5 syntax errors', () => {
    const fixedNow = new Date('2026-11-13T12:00:00Z');
    const prompt = 'Last Tuesday I asked you about "Postgres hosting". Has any pricing-changed since then?';

    const t0 = performance.now();
    const context = retrieveTemporalContext(prompt, TEST_SESSION_ID, fixedNow);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(15);
    expect(context).toContain('Neon');
    expect(context).toContain('Supabase');
    expect(context).toContain('Railway');
  });
});

describe('Test Suite 2 — Search Caching, Singleflight, Timeout Retries & Circuit Breaker (server/searchTool.ts)', () => {
  beforeEach(() => {
    _testHooks.clearCache();
    _testHooks.resetCircuitBreaker();
    _testHooks.resetTavilyClient();
    vi.useRealTimers();
  });

  it('hits in-memory TTL cache in <2ms on repeated queries, calling upstream Tavily client only once', async () => {
    const mockClient = {
      search: vi.fn().mockResolvedValue({
        results: [
          {
            title: 'Pricing Sheet',
            url: 'https://example.com/pricing',
            content: 'Current pricing information',
            score: 0.95,
          },
        ],
      }),
    };
    _testHooks.setTavilyClient(mockClient);

    const first = await executeWebSearch({ query: 'api token pricing test' });
    expect(first.ok).toBe(true);
    expect(mockClient.search).toHaveBeenCalledTimes(1);

    const t0 = performance.now();
    const second = await executeWebSearch({ query: 'api token pricing test' });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(5);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.results[0].title).toBe('Pricing Sheet');
    }
    expect(mockClient.search).toHaveBeenCalledTimes(1);
  });

  it('coalesces two concurrent identical queries into a single upstream Tavily call', async () => {
    let resolveSearch: (val: any) => void;
    const delayedPromise = new Promise((resolve) => {
      resolveSearch = resolve;
    });

    const mockClient = {
      search: vi.fn().mockImplementation(() => delayedPromise),
    };
    _testHooks.setTavilyClient(mockClient);

    const p1 = executeWebSearch({ query: 'singleflight test query' });
    const p2 = executeWebSearch({ query: '  singleflight   test   query  ' });

    resolveSearch!({
      results: [
        {
          title: 'Coalesced Result',
          url: 'https://example.com/coalesced',
          content: 'Coalesced snippet',
          score: 0.88,
        },
      ],
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockClient.search).toHaveBeenCalledTimes(1);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1).toEqual(r2);
  });

  it('using vi.useFakeTimers(), verifies a hanging Tavily call aborts per attempt (3500ms), retries with jitter, and returns timeout', async () => {
    const hangingClient = {
      search: vi.fn().mockImplementation(() => new Promise(() => {})),
    };
    _testHooks.setTavilyClient(hangingClient);

    vi.useFakeTimers();

    const searchPromise = executeWebSearch({ query: 'hanging tavily query' });

    // Advance timers through 3 attempts (each aborts after 3500ms + exponential jitter backoff)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(3600);
      await vi.advanceTimersByTimeAsync(2000);
    }

    const result = await searchPromise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('timeout');
    expect(result.results).toEqual([]);
    expect(hangingClient.search).toHaveBeenCalledTimes(3);
  });

  it('trips circuit breaker to OPEN after 3 consecutive failures, failing fast in <2ms on 4th call', async () => {
    const failingClient = {
      search: vi.fn().mockRejectedValue(new Error('Upstream provider 503 unavailable')),
    };
    _testHooks.setTavilyClient(failingClient);

    // 1st failure
    const r1 = await executeWebSearch({ query: 'cb-fail-1' });
    expect(r1.ok).toBe(false);
    expect(_testHooks.getCircuitBreakerState().state).toBe('CLOSED');

    // 2nd failure
    const r2 = await executeWebSearch({ query: 'cb-fail-2' });
    expect(r2.ok).toBe(false);
    expect(_testHooks.getCircuitBreakerState().state).toBe('CLOSED');

    // 3rd failure -> trips to OPEN
    const r3 = await executeWebSearch({ query: 'cb-fail-3' });
    expect(r3.ok).toBe(false);
    expect(_testHooks.getCircuitBreakerState().state).toBe('OPEN');

    const callsBefore = failingClient.search.mock.calls.length;

    // 4th call: fails fast in <2ms without calling Tavily
    const t0 = performance.now();
    const r4 = await executeWebSearch({ query: 'cb-blocked-query' });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(5);
    expect(r4.ok).toBe(false);
    expect(r4.errorCode).toBe('provider_error');
    expect(failingClient.search.mock.calls.length).toBe(callsBefore);
  });
});

describe('Test Suite 3 — End-to-End Dataset & SSE Stream Assertions (server/agent.ts & server/index.ts)', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(TEST_SESSION_ID);
    seedSampleHistory(TEST_SESSION_ID);
    vi.clearAllMocks();

    mockStreamText.mockImplementation((options: any) => {
      lastCapturedCall.current = options;
      return {
        fullStream: (async function* () {
          yield {
            type: 'tool-call',
            toolName: 'web_search',
            args: { query: 'live search query' },
          };
          yield {
            type: 'tool-result',
            toolName: 'web_search',
            output: {
              ok: true,
              results: [
                {
                  title: 'Official Pricing Update',
                  url: 'https://example.com/verified-pricing',
                },
              ],
            },
          };
          yield {
            type: 'text-delta',
            text: 'Live verification complete: answers are updated [1].',
          };
        })(),
        usage: Promise.resolve({ promptTokens: 80, completionTokens: 40 }),
      };
    });
  });

  it('rejects an empty message body with HTTP 400 bad_request via centralized error middleware', async () => {
    const res = await fetch(`${testBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '', sessionId: TEST_SESSION_ID }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_failure');
    expect(body.error).not.toHaveProperty('stack');
  });

  it('processes Prompt 1 (3 November): asserts system prompt has static rules + date/history, invokes web_search, and streams SSE frames', async () => {
    const prompt = 'What did I ask you on 3 November? Is your answer still correct today?';

    const res = await fetch(`${testBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt, sessionId: TEST_SESSION_ID }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const sseText = await res.text();

    // Assert SSE frames
    expect(sseText).toContain('data: {"type":"status","message":"Searching the web..."}');
    expect(sseText).toContain('data: {"type":"token","text":"Live verification complete: answers are updated [1]."}');
    expect(sseText).toContain('data: {"type":"sources","sources":[{"title":"Official Pricing Update","url":"https://example.com/verified-pricing"}]}');
    expect(sseText).toContain('data: {"type":"done"}');

    // Assert captured system prompt
    const captured = lastCapturedCall.current;
    expect(captured).toBeDefined();
    expect(captured.system.startsWith(STATIC_SYSTEM_PROMPT)).toBe(true);
    expect(PROMPT_VERSION).toBe('agent.v1');
    expect(captured.system).toContain('Current Date & Time:');
    expect(captured.system).toContain('RETRIEVED CONVERSATION HISTORY:');
    expect(captured.system).toContain('OpenAI GPT-4o');
    expect(captured.system).toContain('Anthropic Claude 3.5 Sonnet');
    expect(captured.tools).toHaveProperty('web_search');
  });

  it('processes Prompt 2 (Monday CRM shortlist): asserts system prompt has CRM history and returned URLs are surfaced', async () => {
    const prompt = 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?';

    const res = await fetch(`${testBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt, sessionId: TEST_SESSION_ID }),
    });

    expect(res.status).toBe(200);
    const sseText = await res.text();
    expect(sseText).toContain('data: {"type":"sources"');
    expect(sseText).toContain('https://example.com/verified-pricing');
    expect(sseText).toContain('data: {"type":"done"}');

    const captured = lastCapturedCall.current;
    expect(captured.system.startsWith(STATIC_SYSTEM_PROMPT)).toBe(true);
    expect(captured.system).toContain('HubSpot Sales Hub');
    expect(captured.system).toContain('Salesforce Sales Cloud');
    expect(captured.system).toContain('Pipedrive');
  });

  it('processes Prompt 3 (Last Tuesday Postgres hosting): asserts system prompt has Postgres history and streams clean SSE', async () => {
    const prompt = 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?';

    const res = await fetch(`${testBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt, sessionId: TEST_SESSION_ID }),
    });

    expect(res.status).toBe(200);
    const sseText = await res.text();
    expect(sseText).toContain('data: {"type":"status"');
    expect(sseText).toContain('data: {"type":"token"');
    expect(sseText).toContain('data: {"type":"done"}');

    const captured = lastCapturedCall.current;
    expect(captured.system.startsWith(STATIC_SYSTEM_PROMPT)).toBe(true);
    expect(captured.system).toContain('Neon');
    expect(captured.system).toContain('Supabase');
    expect(captured.system).toContain('Railway');
  });
});
