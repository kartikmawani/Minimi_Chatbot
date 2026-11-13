import { ENV } from './env.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogPayload {
  correlationId?: string | null;
  event: string;
  model?: string | null;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  errorCode?: string | null;
  message?: string;
  prompt?: unknown;
  response?: unknown;
  [key: string]: unknown;
}

export type LogContext = LogPayload & {
  level?: LogLevel;
};

const REDACTED_KEYS = new Set([
  'prompt',
  'prompts',
  'response',
  'responses',
  'userprompt',
  'assistantresponse',
  'rawpayload',
  'rawprompt',
  'rawresponse',
  'content',
  'messages',
]);

export function sanitizePayload<T>(value: T): T {
  if (ENV.LOG_RAW_PAYLOADS === true) {
    return value;
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizePayload) as unknown as T;
  }

  const sanitizedObj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      sanitizedObj[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      sanitizedObj[k] = sanitizePayload(v);
    } else {
      sanitizedObj[k] = v;
    }
  }
  return sanitizedObj as T;
}

function log(level: LogLevel, context: LogContext): void {
  const sanitized = sanitizePayload(context) as Record<string, unknown>;
  const {
    correlationId,
    event,
    model,
    latencyMs,
    tokensIn,
    tokensOut,
    errorCode,
    ...rest
  } = sanitized;

  const record = {
    timestamp: new Date().toISOString(),
    level,
    correlationId: (correlationId as string | undefined) ?? null,
    event: event as string,
    model: (model as string | undefined) ?? null,
    latencyMs: (latencyMs as number | undefined) ?? null,
    tokensIn: (tokensIn as number | undefined) ?? null,
    tokensOut: (tokensOut as number | undefined) ?? null,
    errorCode: (errorCode as string | undefined) ?? null,
    ...rest,
  };

  const line = JSON.stringify(record);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  info: (context: LogPayload | string) => {
    if (typeof context === 'string') {
      log('info', { event: context });
    } else {
      log('info', context);
    }
  },
  warn: (context: LogPayload | string) => {
    if (typeof context === 'string') {
      log('warn', { event: context });
    } else {
      log('warn', context);
    }
  },
  error: (context: LogPayload | string) => {
    if (typeof context === 'string') {
      log('error', { event: context });
    } else {
      log('error', context);
    }
  },
  debug: (context: LogPayload | string) => {
    if (typeof context === 'string') {
      log('debug', { event: context });
    } else {
      log('debug', context);
    }
  },
  log,
  sanitizePayload,
};

export default logger;
