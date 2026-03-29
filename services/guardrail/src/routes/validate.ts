import { Router, Response } from 'express';
import { Logger } from 'pino';
import { ValidationService } from '../services/validationService';
import { ValidationRequest, SmartRouteRequest } from '../utils/types';
import { HTTP_STATUS, ERROR_MESSAGES } from '../utils/constants';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';

export function validateRoutes(logger: Logger): Router {
  const router = Router();
  const validationService = new ValidationService(logger);

  router.use(authMiddleware);

  router.post(
    '/',
    asyncHandler(async (req: AuthRequest, res: Response) => {
      try {
        const validationRequest: ValidationRequest = req.body;

        // Smart route mode — AI-powered upstream selection
        if ((req.body as any).mode === 'smart_route') {
          const smartReq = req.body as SmartRouteRequest;

          if (!smartReq.providerId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              error: ERROR_MESSAGES.MISSING_PROVIDER_ID,
            });
          }
          if (!smartReq.upstreams || smartReq.upstreams.length < 2) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              error: 'Smart route requires at least 2 upstreams',
            });
          }

          const mappedRequest: ValidationRequest = {
            providerId: smartReq.providerId,
            method: smartReq.method,
            path: smartReq.path,
            body: (smartReq as any).requestBody || smartReq.body,
            contentType: smartReq.contentType,
            clientIp: smartReq.clientIp,
            headers: {
              'user-agent': (smartReq as any).userAgent || '',
              'content-type': smartReq.contentType || 'application/json',
              'x-organization-id': (smartReq as any).organizationId || '',
              ...(req.headers as Record<string, string>),
            },
          };

          const policyId = smartReq.policyId || 'default';
          const organizationId = (smartReq as any).organizationId || '';
          const result = await validationService.smartRoute(mappedRequest, smartReq.upstreams, policyId, organizationId);

          logger.info(
            {
              providerId: smartReq.providerId,
              decision: result.decision,
              selectedUpstream: result.selectedUpstream,
              severity: result.severity,
            },
            'Smart route request completed'
          );

          return res.status(HTTP_STATUS.OK).json(result);
        }

        // Validate request structure
        if (!validationRequest.providerId) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            error: ERROR_MESSAGES.MISSING_PROVIDER_ID,
          });
        }

        if (!validationRequest.method || !validationRequest.path) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            error: ERROR_MESSAGES.INVALID_REQUEST,
          });
        }

        // Map Kong request format to ValidationRequest format
        const mappedRequest: ValidationRequest = {
          providerId: validationRequest.providerId,
          method: validationRequest.method,
          path: validationRequest.path,
          body: (validationRequest as any).requestBody || validationRequest.body,
          contentType: validationRequest.contentType,
          clientIp: validationRequest.clientIp || (validationRequest as any).clientIp,
          headers: {
            'user-agent': (validationRequest as any).userAgent || '',
            'content-type': validationRequest.contentType || 'application/json',
            'x-organization-id': (validationRequest as any).organizationId || '',
            ...(req.headers as Record<string, string>),
          },
        };

        // Validate the request
        const policyId = (validationRequest as any).policyId || 'default';
        const organizationId = (validationRequest as any).organizationId || '';
        const result = await validationService.validateRequest(mappedRequest, policyId, organizationId);

        logger.info(
          {
            providerId: validationRequest.providerId,
            decision: result.decision,
            severity: result.severity,
            confidence: result.confidence,
            anonymizationMapCount: result.anonymization_map?.length || 0,
            hasAnonymizationMap: !!result.anonymization_map,
          },
          'Validation request completed'
        );

        res.status(HTTP_STATUS.OK).json(result);
      } catch (error) {
        logger.error(
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            providerId: req.body?.providerId,
          },
          'Validation request failed'
        );

        res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
          error: ERROR_MESSAGES.VALIDATION_FAILED,
          details: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    })
  );

  return router;
}
