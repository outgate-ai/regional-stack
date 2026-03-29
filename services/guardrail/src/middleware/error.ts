import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { HTTP_STATUS } from '../utils/constants';

export interface ErrorWithStatus extends Error {
  status?: number;
  statusCode?: number;
}

export function errorHandler(logger: Logger) {
  return (err: ErrorWithStatus, req: Request, res: Response, next: NextFunction) => {
    // If response already sent, delegate to default Express error handler
    if (res.headersSent) {
      return next(err);
    }

    const status = err.status || err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR;
    const message = err.message || 'Internal server error';

    logger.error(
      {
        error: message,
        status,
        method: req.method,
        url: req.url,
        stack: err.stack,
      },
      'Request error'
    );

    res.status(status).json({
      error: message,
      timestamp: new Date().toISOString(),
      path: req.url,
    });
  };
}

export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
