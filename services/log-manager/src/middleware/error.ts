import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { formatError } from '@outgate/shared';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res
      .status(400)
      .json(formatError('VALIDATION_ERROR', 'Invalid request data', err.errors));
  }

  console.error(err);
  res.status(500).json(formatError('INTERNAL_ERROR', 'An unexpected error occurred'));
}
