import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { HTTP_STATUS } from '../utils/constants';
import { config } from '../utils/config';
import { asyncHandler } from '../middleware/error';

export function healthRoutes(_logger: Logger): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const healthCheck = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'guardrail',
        version: '1.0.0',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        checks: {} as Record<string, any>,
      };

      // Check LLM service connectivity (configurable)
      if (config.healthCheckLLM) {
        try {
          const startTime = Date.now();
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), config.llmHealthTimeoutMs);

          const response = await fetch(config.llm.endpoint, {
            method: 'HEAD',
            signal: controller.signal,
          });

          clearTimeout(timeoutId);
          const responseTime = Date.now() - startTime;

          healthCheck.checks.llm = {
            status: response.ok ? 'ok' : 'error',
            responseTime,
            endpoint: config.llm.endpoint,
            provider: config.llm.provider,
          };

          if (!response.ok) {
            healthCheck.status = 'degraded';
          }
        } catch (error) {
          healthCheck.checks.llm = {
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
            endpoint: config.llm.endpoint,
            provider: config.llm.provider,
          };
          healthCheck.status = 'degraded';
        }
      } else {
        healthCheck.checks.llm = {
          status: 'skipped',
          message: 'LLM health check disabled (set GUARDRAIL_HEALTH_CHECK_LLM=true to enable)',
        };
      }

      const statusCode =
        healthCheck.status === 'ok'
          ? HTTP_STATUS.OK
          : healthCheck.status === 'degraded'
            ? HTTP_STATUS.OK
            : HTTP_STATUS.SERVICE_UNAVAILABLE;

      res.status(statusCode).json(healthCheck);
    })
  );

  router.get(
    '/ready',
    asyncHandler(async (req: Request, res: Response) => {
      res.status(HTTP_STATUS.OK).json({
        status: 'ready',
        timestamp: new Date().toISOString(),
      });
    })
  );

  return router;
}
