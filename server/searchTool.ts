import { tavily } from '@tavily/core';
import { tool } from 'ai';
import { z } from 'zod';
import pLimit from 'p-limit';
import { ENV } from './env.js';
import { logger } from './logger.js';
import type { ErrorCode } from './errors.js';

// 1. Input Contract & Normalization
export const searchInputSchema = z.object({
  query: z.string().min(2).max(200),
  timeRange: z.enum(['day', 'week', 'month', 'year']).optional(),
});

export type SearchInput = z.infer<typeof searchInputSchema>;

export function normalizeCacheKey(query: string, timeRange?: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ') + '|' + (timeRange ?? 'any');
}

// 2. Response Types
export interface CleanSearchResult {
  title: string;
  url: string;
  publishedDate: string | null;
  snippet: string;
}

export interface SearchSuccessResponse {
  ok: true;
  results: CleanSearchResult[];
}

export interface SearchErrorResponse {
  ok: false;
  errorCode: ErrorCode;
  error: 'Live web search is currently unavailable.';
  results: [];
}

export type SearchToolResponse = SearchSuccessResponse | SearchErrorResponse;

interface CacheEntry {
  data: CleanSearchResult[];
  expiresAt: number;
}

// Bounded in-memory TTL Cache & Singleflight Map
const MAX_CACHE_ENTRIES = 200;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const cache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<SearchToolResponse>>();

// 3. Resilience Stack Configuration
const CONCURRENCY_LIMIT = 5;
const limit = pLimit(CONCURRENCY_LIMIT);

// Circuit Breaker
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreaker {
  state: CircuitState;
  consecutiveFailures: number;
  lastStateChange: number;
}

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000; // 30 seconds

const circuitBreaker: CircuitBreaker = {
  state: 'CLOSED',
  consecutiveFailures: 0,
  lastStateChange: 0,
};

let probeInFlight = false;

// Tavily client
let tavilyClientInstance: ReturnType<typeof tavily> | null = null;

function getTavilyClient(): ReturnType<typeof tavily> {
  if (!tavilyClientInstance) {
    tavilyClientInstance = tavily({ apiKey: ENV.TAVILY_API_KEY });
  }
  return tavilyClientInstance;
}

// Helper: Canonicalize URL (strip utm_* parameters and trailing slash)
export function canonicalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const keysToRemove: string[] = [];
    for (const key of url.searchParams.keys()) {
      if (key.toLowerCase().startsWith('utm_')) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      url.searchParams.delete(key);
    }
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    let res = url.toString();
    if (res.endsWith('/') && !res.endsWith('://')) {
      res = res.slice(0, -1);
    }
    return res;
  } catch {
    return rawUrl
      .replace(/([?&])utm_[^&]+(&|$)/gi, '$1')
      .replace(/[?&]$/, '')
      .replace(/\/+$/, '');
  }
}

// Helper: Clean HTML tags and excess whitespace
function cleanText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper: Classify transient failures
function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const status =
    (err as { status?: number; statusCode?: number }).status ??
    (err as { status?: number; statusCode?: number }).statusCode;

  if (status === 400 || status === 401 || status === 403) {
    return false;
  }
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  if (err instanceof Error) {
    if (
      err.name === 'AbortError' ||
      err.message?.includes('timeout') ||
      err.message?.includes('AbortError')
    ) {
      return true;
    }
  }
  const code = (err as { code?: string }).code;
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true;
  }
  const msg = (err as { message?: string }).message ?? '';
  if (/429|502|503|504|ECONNRESET|ETIMEDOUT|timeout|abort/i.test(msg)) {
    return true;
  }
  return false;
}

// Helper: Execute with retry, per-attempt timeout, and Full Jitter backoff
async function executeWithRetry(
  query: string,
  timeRange?: 'day' | 'week' | 'month' | 'year',
  correlationId?: string
): Promise<any> {
  const maxRetries = 2;
  const perAttemptTimeoutMs = 3500;
  const baseDelayMs = 300;
  const maxDelayMs = 1500;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      const abortErr = new Error('Per-attempt search timeout exceeded');
      abortErr.name = 'AbortError';
      controller.abort(abortErr);
    }, perAttemptTimeoutMs);

    try {
      const searchOptions: Record<string, unknown> = {
        searchDepth: 'basic',
        maxResults: 5,
        includePublishedDate: true,
        timeout: Math.ceil(perAttemptTimeoutMs / 1000),
      };
      if (timeRange) {
        searchOptions.timeRange = timeRange;
      }

      const client = getTavilyClient();
      const searchPromise = client.search(query, searchOptions as any);

      const abortPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          const err = new Error('Per-attempt search timeout exceeded');
          err.name = 'AbortError';
          reject(err);
        });
      });

      const response = await Promise.race([searchPromise, abortPromise]);
      return response;
    } catch (err: any) {
      lastError = err;

      const status = err?.status ?? err?.statusCode;
      if (status === 400 || status === 401 || status === 403) {
        throw err;
      }

      if (attempt >= maxRetries) {
        break;
      }

      if (!isTransientError(err)) {
        throw err;
      }

      const delayMs = Math.floor(
        Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
      );

      logger.warn({
        correlationId,
        event: 'search_retry',
        attempt: attempt + 1,
        delayMs,
        errorCode: err.name === 'AbortError' ? 'timeout' : 'provider_error',
        message: err.message,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError;
}

// 4. Result Cleaning & URL Deduplication
function cleanAndDeduplicateResults(rawResults: any[]): CleanSearchResult[] {
  const seenUrls = new Set<string>();
  const cleanResults: CleanSearchResult[] = [];

  for (const item of rawResults) {
    if (typeof item.score === 'number' && item.score < 0.35) {
      continue;
    }
    const rawUrl = item.url ?? '';
    const canonical = canonicalizeUrl(rawUrl);
    if (!canonical || seenUrls.has(canonical)) {
      continue;
    }
    seenUrls.add(canonical);

    cleanResults.push({
      title: cleanText(item.title ?? ''),
      url: canonical,
      publishedDate: item.publishedDate ? String(item.publishedDate) : null,
      snippet: cleanText(item.content ?? item.snippet ?? '').slice(0, 400),
    });

    if (cleanResults.length === 5) {
      break;
    }
  }

  return cleanResults;
}

// 5. Main executeWebSearch function
export async function executeWebSearch(
  rawInput: { query: string; timeRange?: 'day' | 'week' | 'month' | 'year' },
  correlationId?: string
): Promise<SearchToolResponse> {
  const startTime = Date.now();

  try {
    // 1. Input Contract Validation
    const parsedInput = searchInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      logger.warn({
        correlationId,
        event: 'search_failed',
        errorCode: 'validation_failure',
        message: 'Invalid search input contract',
        details: parsedInput.error.issues,
      });
      return {
        ok: false,
        errorCode: 'validation_failure',
        error: 'Live web search is currently unavailable.',
        results: [],
      };
    }

    const { query, timeRange } = parsedInput.data;
    const cacheKey = normalizeCacheKey(query, timeRange);

    // 2. Fast TTL Cache Check (<1ms)
    const cached = cache.get(cacheKey);
    if (cached) {
      if (Date.now() < cached.expiresAt) {
        logger.info({
          correlationId,
          event: 'search_cache_hit',
          query: cacheKey,
          latencyMs: Date.now() - startTime,
        });
        return {
          ok: true,
          results: cached.data,
        };
      }
      cache.delete(cacheKey);
    }

    // 3. Singleflight Coalescing
    const existingFlight = inFlightRequests.get(cacheKey);
    if (existingFlight) {
      return await existingFlight;
    }

    // 4. Circuit Breaker Fast-Fail Check (<1ms)
    if (circuitBreaker.state === 'OPEN') {
      if (Date.now() - circuitBreaker.lastStateChange >= CIRCUIT_COOLDOWN_MS) {
        circuitBreaker.state = 'HALF_OPEN';
        circuitBreaker.lastStateChange = Date.now();
      } else {
        logger.error({
          correlationId,
          event: 'search_circuit_open',
          errorCode: 'provider_error',
          message: 'Circuit breaker is OPEN. Search request blocked in <1ms.',
        });
        return {
          ok: false,
          errorCode: 'provider_error',
          error: 'Live web search is currently unavailable.',
          results: [],
        };
      }
    }

    if (circuitBreaker.state === 'HALF_OPEN' && probeInFlight) {
      logger.error({
        correlationId,
        event: 'search_circuit_open',
        errorCode: 'provider_error',
        message: 'Circuit breaker is HALF_OPEN. Probe already in flight.',
      });
      return {
        ok: false,
        errorCode: 'provider_error',
        error: 'Live web search is currently unavailable.',
        results: [],
      };
    }

    // 5. Launch upstream request with concurrency cap
    const isProbe = circuitBreaker.state === 'HALF_OPEN';
    if (isProbe) {
      probeInFlight = true;
    }

    const fetchPromise = (async (): Promise<SearchToolResponse> => {
      try {
        const rawData = await limit(() =>
          executeWithRetry(query, timeRange, correlationId)
        );

        // On upstream success: reset circuit breaker if probe or closed
        if (circuitBreaker.state === 'HALF_OPEN') {
          circuitBreaker.state = 'CLOSED';
        }
        circuitBreaker.consecutiveFailures = 0;

        const rawResults = Array.isArray(rawData?.results) ? rawData.results : [];
        const cleanResults = cleanAndDeduplicateResults(rawResults);

        // Save to cache (bounded eviction: remove oldest entry when full)
        if (cache.size >= MAX_CACHE_ENTRIES) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey !== undefined) {
            cache.delete(oldestKey);
          }
        }
        cache.set(cacheKey, {
          data: cleanResults,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });

        logger.info({
          correlationId,
          event: 'search_completed',
          query: cacheKey,
          latencyMs: Date.now() - startTime,
          resultsCount: cleanResults.length,
        });

        return {
          ok: true,
          results: cleanResults,
        };
      } catch (err: any) {
        const isTimeout =
          err?.name === 'AbortError' ||
          err?.message?.includes('timeout') ||
          err?.code === 'ETIMEDOUT';
        const errorCode: ErrorCode = isTimeout ? 'timeout' : 'provider_error';

        // Circuit Breaker Failure Handling
        if (circuitBreaker.state === 'HALF_OPEN') {
          circuitBreaker.state = 'OPEN';
          circuitBreaker.lastStateChange = Date.now();
        } else if (circuitBreaker.state === 'CLOSED') {
          circuitBreaker.consecutiveFailures++;
          if (circuitBreaker.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
            circuitBreaker.state = 'OPEN';
            circuitBreaker.lastStateChange = Date.now();
            logger.error({
              correlationId,
              event: 'search_circuit_open',
              errorCode: 'provider_error',
              message: `Circuit breaker opened after ${circuitBreaker.consecutiveFailures} consecutive failures`,
            });
          }
        }

        logger.error({
          correlationId,
          event: 'search_failed',
          errorCode,
          message: err?.message ?? 'Upstream search error',
          latencyMs: Date.now() - startTime,
        });

        return {
          ok: false,
          errorCode,
          error: 'Live web search is currently unavailable.',
          results: [],
        };
      } finally {
        if (isProbe) {
          probeInFlight = false;
        }
        inFlightRequests.delete(cacheKey);
      }
    })();

    inFlightRequests.set(cacheKey, fetchPromise);
    return await fetchPromise;
  } catch (unexpectedError: any) {
    logger.error({
      correlationId,
      event: 'search_failed',
      errorCode: 'provider_error',
      message: unexpectedError?.message ?? 'Unexpected error in search tool',
      latencyMs: Date.now() - startTime,
    });
    return {
      ok: false,
      errorCode: 'provider_error',
      error: 'Live web search is currently unavailable.',
      results: [],
    };
  }
}

// 6. Export webSearchTool
export const webSearchTool = tool({
  description:
    'Search the live web for real-time information, current events, and up-to-date facts. You can emit multiple parallel web_search calls in one step when comparing multiple entities or verifying whether past answers are still accurate today.',
  inputSchema: searchInputSchema,
  execute: async (input) => executeWebSearch(input),
});

// Testing export hooks
export const _testHooks = {
  resetCircuitBreaker: () => {
    circuitBreaker.state = 'CLOSED';
    circuitBreaker.consecutiveFailures = 0;
    circuitBreaker.lastStateChange = 0;
    probeInFlight = false;
  },
  setCircuitBreakerState: (state: CircuitState, lastChange = Date.now()) => {
    circuitBreaker.state = state;
    circuitBreaker.lastStateChange = lastChange;
  },
  getCircuitBreakerState: () => ({ ...circuitBreaker, probeInFlight }),
  clearCache: () => {
    cache.clear();
  },
  getCacheSize: () => cache.size,
  getInFlightSize: () => inFlightRequests.size,
  setTavilyClient: (mockClient: any) => {
    tavilyClientInstance = mockClient;
  },
  resetTavilyClient: () => {
    tavilyClientInstance = null;
  },
  setCacheEntry: (key: string, data: CleanSearchResult[], ttlMs = CACHE_TTL_MS) => {
    cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  },
};

export default webSearchTool;
