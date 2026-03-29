import { Request, Response, NextFunction } from 'express';
import { HTTP_STATUS } from '../utils/constants';

export interface AuthRequest extends Request {
  organizationId?: string;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const organizationId = req.headers['x-organization-id'] as string;
  const internalApiKey = req.headers['x-internal-api-key'] as string;

  // For internal service communication, check internal API key
  const expectedInternalKey = process.env.INTERNAL_API_KEY;
  if (expectedInternalKey && internalApiKey === expectedInternalKey) {
    req.organizationId = organizationId;
    return next();
  }

  // For direct validation requests, organization ID should be present
  if (!organizationId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Organization ID is required',
    });
  }

  req.organizationId = organizationId;
  next();
}
