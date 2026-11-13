import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger.js';

export type ErrorCode =
  | 'bad_request'
  | 'timeout'
  | 'provider_error'
  | 'validation_failure'
  | 'internal_error';

export const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failure: 400,
  timeout: 504,
  provider_error: 502,
  internal_error: 500,
};

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    details?: unknown,
    statusCode?: number
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode ?? ERROR_STATUS_MAP[code] ?? 500;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void => {
  const correlationId =
    (req as { correlationId?: string }).correlationId ??
    (req.headers['x-correlation-id'] as string | undefined) ??
    null;

  if (err instanceof ZodError) {
    const statusCode = 400;
    const errorCode: ErrorCode = 'validation_failure';

    logger.warn({
      correlationId,
      event: 'request_validation_failure',
      errorCode,
      details: err.issues,
    });

    res.status(statusCode).json({
      error: {
        code: errorCode,
        message: 'Validation failed',
        details: err.issues,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    const level = err.statusCode >= 500 ? 'error' : 'warn';

    logger[level]({
      correlationId,
      event: 'app_error',
      errorCode: err.code,
      message: err.message,
      details: err.details,
    });

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal server error';

  logger.error({
    correlationId,
    event: 'unhandled_internal_error',
    errorCode: 'internal_error',
    message,
    stack: err instanceof Error ? err.stack : undefined,
  });

  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Internal server error',
    },
  });
};

export default errorHandler;
