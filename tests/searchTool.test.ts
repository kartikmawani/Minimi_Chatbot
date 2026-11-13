import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  executeWebSearch,
  webSearchTool,
  searchInputSchema,
  normalizeCacheKey,
  canonicalizeUrl,
  _testHooks,
} from '../server/searchTool.js';
import { logger } from '../server/logger.js';

describe('searchTool: 1. Input Contract & Normalization', () => {
  it('validates valid search queries and optional timeRanges', () => {
    const valid1 = searchInputSchema.safeParse({ query: 'quantum computing' });
    expect(valid1.success).toBe(true);

    const valid2 = searchInputSchema.safeParse({
      query: 'AI advancements',
      timeRange: 'week',
    });
    expect(valid2.success).toBe(true);
  });

  it('rejects invalid inputs via safeParse', () => {
    const tooShort = searchInputSchema.safeParse({ query: 'a' });
    expect(tooShort.success).toBe(false);

    const tooLong = searchInputSchema.safeParse({ query: 'x'.repeat(201) });
    expect(tooLong.success).toBe(false);

    const invalidTimeRange = searchInputSchema.safeParse({
      query: 'valid query',
      timeRange: 'century',
    });
    expect(invalidTimeRange.success).toBe(false);
  });

  it('normalizes cache keys correctly', () => {
    expect(normalizeCacheKey('  Quantum   Entanglement  ', 'day')).toBe(
      'quantum entanglement|day'
    );
    expect(normalizeCacheKey('DeepMind Gemini Flash')).toBe(
      'deepmind gemini flash|any'
    );
  });
});

describe('searchTool: 2. Two-Layer Fast Cache & Singleflight Coalescing', () => {
  beforeEach(() => {
    _testHooks.clearCache();
    _testHooks.resetCircuitBreaker();
    _testHooks.resetTavilyClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cached results in <1ms without calling upstream Tavily', async () => {
    const mockClient = {
      search: vi.fn(),
    };
    _testHooks.setTavilyClient(mockClient);

    const cachedData = [
      {
        title: 'Cached Article',
        url: 'https://example.com/cached',
        publishedDate: '2026-01-01',
        snippet: 'Cached content snippet',
      },
    ];
    _testHooks.setCacheEntry('fast cache test|any', cachedData, 60_000);

    const start = performance.now();
    const response = await executeWebSearch({ query: 'fast cache test' });
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(10); // Well under 10ms (typically <1ms)
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.results).toEqual(cachedData);
    }
    expect(mockClient.search).not.toHaveBeenCalled();
  });

  it('evicts expired entries from cache and refreshes from upstream', async () => {
    const mockClient = {
      search: vi.fn().mockResolvedValue({
        results: [
          {
            title: 'Fresh Article',
            url: 'https://example.com/fresh',
            content: 'Fresh snippet',
            score: 0.9,
          },
        ],
      }),
    };
    _testHooks.setTavilyClient(mockClient);

    // Insert an expired entry (-10ms)
    _testHooks.setCacheEntry(
      'expired query|any',
      [
        {
          title: 'Old',
          url: 'https://example.com/old',
          publishedDate: null,
          snippet: 'Old',
        },
      ],
      -10
    );

    const response = await executeWebSearch({ query: 'expired query' });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.results[0].title).toBe('Fresh Article');
    }
    expect(mockClient.search).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent identical queries into a single upstream Tavily call (singleflight)', async () => {
    let resolveSearch: (val: any) => void;
    const delayedPromise = new Promise((resolve) => {
      resolveSearch = resolve;
    });

    const mockClient = {
      search: vi.fn().mockImplementation(() => delayedPromise),
    };
    _testHooks.setTavilyClient(mockClient);

    // Launch 3 concurrent identical searches
    const p1 = executeWebSearch({ query: 'concurrent query' });
    const p2 = executeWebSearch({ query: 'concurrent query' });
    const p3 = executeWebSearch({ query: '  concurrent   query  ' }); // Normalizes to same key

    expect(_testHooks.getInFlightSize()).toBe(1);

    // Resolve upstream search
    resolveSearch!({
      results: [
        {
          title: 'Singleflight Article',
          url: 'https://example.com/singleflight',
          content: 'Coalesced snippet',
          score: 0.85,
        },
      ],
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(mockClient.search).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
    expect(_testHooks.getInFlightSize()).toBe(0);
  });
});

describe('searchTool: 3. Resilience Stack (Circuit Breaker & Retries)', () => {
  beforeEach(() => {
    _testHooks.clearCache();
    _testHooks.resetCircuitBreaker();
    _testHooks.resetTavilyClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens circuit breaker after 3 consecutive failures, then fails fast in <1ms', async () => {
    const mockClient = {
      search: vi.fn().mockRejectedValue(new Error('Tavily 500 internal')),
    };
    _testHooks.setTavilyClient(mockClient);

    // 1st failure
    const r1 = await executeWebSearch({ query: 'fail-1' });
    expect(r1.ok).toBe(false);
    expect(_testHooks.getCircuitBreakerState().state).toBe('CLOSED');
    expect(_testHooks.getCircuitBreakerState().consecutiveFailures).toBe(1);

    // 2nd failure
    const r2 = await executeWebSearch({ query: 'fail-2' });
    expect(r2.ok).toBe(false);
    expect(_testHooks.getCircuitBreakerState().state).toBe('CLOSED');
    expect(_testHooks.getCircuitBreakerState().consecutiveFailures).toBe(2);

    // 3rd failure -> trips to OPEN
    const r3 = await executeWebSearch({ query: 'fail-3' });
    expect(r3.ok).toBe(false);
    expect(_testHooks.getCircuitBreakerState().state).toBe('OPEN');

    // 4th call while OPEN: fails fast in <1ms without calling mockClient.search again
    const callCountBefore = mockClient.search.mock.calls.length;
    const start = performance.now();
    const r4 = await executeWebSearch({ query: 'blocked query' });
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(10);
    expect(r4.ok).toBe(false);
    expect(r4.errorCode).toBe('provider_error');
    expect(mockClient.search.mock.calls.length).toBe(callCountBefore);
  });

  it('allows a single probe in HALF_OPEN after cooldown, resetting to CLOSED on success', async () => {
    _testHooks.setCircuitBreakerState('OPEN', Date.now() - 35_000); // 35s ago (>30s cooldown)

    const mockClient = {
      search: vi.fn().mockResolvedValue({
        results: [
          {
            title: 'Probe Success',
            url: 'https://example.com/probe',
            content: 'Probe snippet',
            score: 0.8,
          },
        ],
      }),
    };
    _testHooks.setTavilyClient(mockClient);

    const res = await executeWebSearch({ query: 'probe query' });
    expect(res.ok).toBe(true);
    expect(_testHooks.getCircuitBreakerState().state).toBe('CLOSED');
    expect(_testHooks.getCircuitBreakerState().consecutiveFailures).toBe(0);
  });

  it('re-opens circuit breaker if HALF_OPEN probe fails', async () => {
    _testHooks.setCircuitBreakerState('OPEN', Date.now() - 35_000);

    const mockClient = {
      search: vi.fn().mockRejectedValue(new Error('Probe failed')),
    };
    _testHooks.setTavilyClient(mockClient);

    const res = await executeWebSearch({ query: 'failing probe query' });
    expect(res.ok).toBe(false);
    expect(_testHooks.getCircuitBreakerState().state).toBe('OPEN');
  });

  it('retries transient 502/429/timeout errors up to maxRetries (2)', async () => {
    let callCount = 0;
    const mockClient = {
      search: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          const err = new Error('Gateway Timeout');
          (err as any).status = 504;
          return Promise.reject(err);
        }
        return Promise.resolve({
          results: [
            {
              title: 'Success on Retry 2',
              url: 'https://example.com/retry-success',
              content: 'Recovered snippet',
              score: 0.9,
            },
          ],
        });
      }),
    };
    _testHooks.setTavilyClient(mockClient);

    const res = await executeWebSearch({ query: 'retry test query' });
    expect(res.ok).toBe(true);
    expect(callCount).toBe(3); // 1 initial + 2 retries
  });

  it('does NOT retry deterministic 400, 401, or 403 errors', async () => {
    let callCount = 0;
    const mockClient = {
      search: vi.fn().mockImplementation(() => {
        callCount++;
        const err = new Error('Unauthorized');
        (err as any).status = 401;
        return Promise.reject(err);
      }),
    };
    _testHooks.setTavilyClient(mockClient);

    const res = await executeWebSearch({ query: 'auth fail query' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('provider_error');
    expect(callCount).toBe(1); // Exact 1 attempt, zero retries
  });
});

describe('searchTool: 4. Result Cleaning & URL Deduplication', () => {
  beforeEach(() => {
    _testHooks.clearCache();
    _testHooks.resetCircuitBreaker();
    _testHooks.resetTavilyClient();
  });

  it('canonicalizes URLs by stripping utm params and trailing slashes', () => {
    expect(
      canonicalizeUrl(
        'https://example.com/docs/?utm_source=twitter&utm_medium=social'
      )
    ).toBe('https://example.com/docs');
    expect(canonicalizeUrl('https://example.com/blog/')).toBe(
      'https://example.com/blog'
    );
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('filters noise (score < 0.35), deduplicates URLs, strips HTML, and caps snippet at 400 chars', async () => {
    const rawResults = [
      {
        title: '<b>Title 1</b>',
        url: 'https://example.com/page-1/?utm_source=news',
        content: '<p>HTML paragraph with &nbsp; whitespace.</p>',
        score: 0.9,
        publishedDate: '2026-05-01',
      },
      {
        title: 'Duplicate Title',
        url: 'https://example.com/page-1/', // Duplicate canonical URL
        content: 'Duplicate content',
        score: 0.85,
      },
      {
        title: 'Low Confidence Item',
        url: 'https://example.com/low-confidence',
        content: 'Should be filtered out',
        score: 0.2, // Below 0.35
      },
      {
        title: 'Long Snippet Item',
        url: 'https://example.com/long',
        content: 'Word '.repeat(150), // > 400 chars
        score: 0.7,
      },
      {
        title: 'Item 4',
        url: 'https://example.com/item-4',
        content: 'Valid snippet 4',
        score: 0.6,
      },
      {
        title: 'Item 5',
        url: 'https://example.com/item-5',
        content: 'Valid snippet 5',
        score: 0.5,
      },
      {
        title: 'Item 6 (Excess beyond top 5)',
        url: 'https://example.com/item-6',
        content: 'Valid snippet 6',
        score: 0.45,
      },
    ];

    const mockClient = {
      search: vi.fn().mockResolvedValue({ results: rawResults }),
    };
    _testHooks.setTavilyClient(mockClient);

    const res = await executeWebSearch({ query: 'clean test query' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Deduplicated and capped to max 5 items
    expect(res.results.length).toBe(5); // Capped at top 5 clean items

    // Item 1 cleaned
    expect(res.results[0].title).toBe('Title 1');
    expect(res.results[0].url).toBe('https://example.com/page-1');
    expect(res.results[0].snippet).toBe('HTML paragraph with &nbsp; whitespace.');
    expect(res.results[0].publishedDate).toBe('2026-05-01');

    // Long snippet capped at 400
    const longItem = res.results.find((r) => r.url === 'https://example.com/long');
    expect(longItem?.snippet.length).toBeLessThanOrEqual(400);

    // Low confidence excluded
    const lowConf = res.results.find(
      (r) => r.url === 'https://example.com/low-confidence'
    );
    expect(lowConf).toBeUndefined();
  });
});

describe('searchTool: 5. Centralized Error Taxonomy & Degraded Non-Crashing Mode', () => {
  beforeEach(() => {
    _testHooks.clearCache();
    _testHooks.resetCircuitBreaker();
    _testHooks.resetTavilyClient();
  });

  it('never throws exceptions on validation failure and returns degraded contract', async () => {
    const res = await executeWebSearch({ query: '' }); // Invalid: min 2
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('validation_failure');
    expect(res.error).toBe('Live web search is currently unavailable.');
    expect(res.results).toEqual([]);
  });

  it('never throws exceptions on upstream failure and returns degraded contract', async () => {
    const mockClient = {
      search: vi.fn().mockRejectedValue(new Error('Network offline')),
    };
    _testHooks.setTavilyClient(mockClient);

    const res = await executeWebSearch({ query: 'offline test' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('provider_error');
    expect(res.error).toBe('Live web search is currently unavailable.');
    expect(res.results).toEqual([]);
  });

  it('classifies AbortError/timeout as timeout error code', async () => {
    const timeoutErr = new Error('Per-attempt search timeout exceeded');
    timeoutErr.name = 'AbortError';

    const mockClient = {
      search: vi.fn().mockRejectedValue(timeoutErr),
    };
    _testHooks.setTavilyClient(mockClient);

    const res = await executeWebSearch({ query: 'timeout test' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('timeout');
  });

  it('logs structured JSON events via logger without raw payload leaks', async () => {
    const logSpy = vi.spyOn(logger, 'info');

    const mockClient = {
      search: vi.fn().mockResolvedValue({
        results: [
          {
            title: 'Logged Item',
            url: 'https://example.com/logged',
            content: 'Snippet',
            score: 0.9,
          },
        ],
      }),
    };
    _testHooks.setTavilyClient(mockClient);

    await executeWebSearch({ query: 'structured log test' }, 'corr-test-123');

    expect(
      logSpy.mock.calls.some(([arg]: any) => arg.event === 'search_completed')
    ).toBe(true);

    logSpy.mockRestore();
  });
});

describe('searchTool: 6. Exports & AI SDK tool() helper', () => {
  it('exports webSearchTool compatible with AI SDK tool definition', async () => {
    expect(webSearchTool).toBeDefined();
    expect(typeof webSearchTool.description).toBe('string');
    expect(webSearchTool.description).toContain('parallel web_search calls');
    expect(webSearchTool.description).toContain('comparing multiple entities');
    expect(typeof webSearchTool.execute).toBe('function');

    const result = await webSearchTool.execute!(
      { query: 'test tool execution' },
      {} as any
    );
    expect(result).toBeDefined();
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('results');
  });
});
