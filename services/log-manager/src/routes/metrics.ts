import { Router } from 'express';
import Redis from 'ioredis';
import { Logger } from 'pino';
import {
  MetricsAggregationEngine,
  MetricsQueryOptions,
} from '../services/MetricsAggregationEngine';
import {
  loadMetricsConfiguration,
  validateTimespan,
  validateGranularity,
  getOptimalGranularity,
} from '../config/metrics';

export function metricsRouter(redis: Redis, logger: Logger): Router {
  const router = Router();

  // Initialize metrics aggregation engine
  let aggregationEngine: MetricsAggregationEngine | null = null;
  try {
    const metricsConfig = loadMetricsConfiguration();
    if (metricsConfig.enabled) {
      aggregationEngine = new MetricsAggregationEngine(redis, logger, metricsConfig);
      logger.info('Metrics aggregation engine initialized');
    }
  } catch (error) {
    logger.error('Failed to initialize metrics aggregation engine', { error });
  }

  // Middleware to check if metrics are enabled
  const requireMetrics = (req: any, res: any, next: any) => {
    if (!aggregationEngine) {
      return res.status(503).json({
        error: 'Metrics service not available',
        message: 'Metrics collection may be disabled or misconfigured',
      });
    }
    next();
  };

  /**
   * Get top upstreams for a provider (router) with summary metrics
   */
  router.get('/providers/:providerId/upstreams', requireMetrics, async (req, res, next) => {
    try {
      const { providerId } = req.params;
      const { timespan = '24h', granularity, organizationId } = req.query;

      if (!organizationId) {
        return res.status(403).json({
          error: 'Organization ID is required',
        });
      }

      if (!validateTimespan(timespan as string)) {
        return res.status(400).json({
          error: 'Invalid timespan',
          validValues: ['1h', '24h', '7d', '30d', '90d', '1y'],
        });
      }

      const effectiveGranularity =
        (granularity as string) || getOptimalGranularity(timespan as string);

      const options: MetricsQueryOptions = {
        timespan: timespan as any,
        granularity: effectiveGranularity as any,
      };

      const upstreams = await aggregationEngine!.getProviderUpstreams(
        organizationId as string,
        providerId,
        options
      );

      // Fetch time series for each upstream and aggregate into target totals
      const upstreamSeries = await Promise.all(
        upstreams.map((u) =>
          aggregationEngine!.getProviderUpstreamMetrics(
            organizationId as string,
            providerId,
            u.id,
            options
          ).catch(() => null)
        )
      );

      // Aggregate all upstream time series into combined target totals
      const targetTimeSeries: Record<number, { s2xx: number; s4xx: number; s5xx: number }> = {};
      for (const series of upstreamSeries) {
        if (!series?.data) continue;
        for (const point of series.data) {
          if (!targetTimeSeries[point.timestamp]) {
            targetTimeSeries[point.timestamp] = { s2xx: 0, s4xx: 0, s5xx: 0 };
          }
          targetTimeSeries[point.timestamp].s2xx += point.status_2xx || 0;
          targetTimeSeries[point.timestamp].s4xx += point.status_4xx || 0;
          targetTimeSeries[point.timestamp].s5xx += point.status_5xx || 0;
        }
      }

      const targetData = Object.entries(targetTimeSeries)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([ts, counts]) => ({ timestamp: Number(ts), ...counts }));

      res.json({ provider_id: providerId, upstreams, target_status_series: targetData });
    } catch (error) {
      logger.error('Failed to get provider upstream metrics', { providerId: req.params.providerId, error });
      next(error);
    }
  });

  /**
   * Get per-model token breakdown for a provider (for cost estimation)
   */
  router.get('/providers/:providerId/models', requireMetrics, async (req, res, next) => {
    try {
      const { providerId } = req.params;
      const { timespan = '30d', granularity, organizationId } = req.query;
      if (!organizationId) return res.status(403).json({ error: 'Organization ID is required' });
      if (!validateTimespan(timespan as string)) return res.status(400).json({ error: 'Invalid timespan' });
      const effectiveGranularity = (granularity as string) || getOptimalGranularity(timespan as string);
      const options: MetricsQueryOptions = { timespan: timespan as any, granularity: effectiveGranularity as any };
      const models = await aggregationEngine!.getProviderModelBreakdown(organizationId as string, providerId, options);
      res.json({ provider_id: providerId, models });
    } catch (error) {
      logger.error('Failed to get provider model breakdown', { providerId: req.params.providerId, error });
      next(error);
    }
  });

  /**
   * Get per-model token breakdown for a share (for cost estimation)
   */
  router.get('/shares/:shareId/models', requireMetrics, async (req, res, next) => {
    try {
      const { shareId } = req.params;
      const { timespan = '30d', granularity, organizationId } = req.query;
      if (!organizationId) return res.status(403).json({ error: 'Organization ID is required' });
      if (!validateTimespan(timespan as string)) return res.status(400).json({ error: 'Invalid timespan' });
      const effectiveGranularity = (granularity as string) || getOptimalGranularity(timespan as string);
      const options: MetricsQueryOptions = { timespan: timespan as any, granularity: effectiveGranularity as any };
      const models = await aggregationEngine!.getShareModelBreakdown(organizationId as string, shareId, options);
      res.json({ share_id: shareId, models });
    } catch (error) {
      logger.error('Failed to get share model breakdown', { shareId: req.params.shareId, error });
      next(error);
    }
  });

  /**
   * Get per-model token breakdown for a user/API key (for cost estimation)
   */
  router.get('/users/:userId/models', requireMetrics, async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { timespan = '30d', granularity, organizationId } = req.query;
      if (!organizationId) return res.status(403).json({ error: 'Organization ID is required' });
      if (!validateTimespan(timespan as string)) return res.status(400).json({ error: 'Invalid timespan' });
      const effectiveGranularity = (granularity as string) || getOptimalGranularity(timespan as string);
      const options: MetricsQueryOptions = { timespan: timespan as any, granularity: effectiveGranularity as any };
      const models = await aggregationEngine!.getUserModelBreakdown(organizationId as string, userId, options);
      res.json({ user_id: userId, models });
    } catch (error) {
      logger.error('Failed to get user model breakdown', { userId: req.params.userId, error });
      next(error);
    }
  });

  /**
   * Get top shares with metrics
   */
  router.get('/shares', requireMetrics, async (req, res, next) => {
    try {
      const { timespan = '24h', granularity, organizationId } = req.query;
      if (!organizationId) {
        return res.status(403).json({ error: 'Organization ID is required' });
      }
      const effectiveGranularity =
        (granularity as string) || getOptimalGranularity(timespan as string);
      const options: MetricsQueryOptions = {
        timespan: timespan as any,
        granularity: effectiveGranularity as any,
      };
      const shares = await aggregationEngine!.getTopShares(
        organizationId as string,
        options
      );
      res.json({ shares });
    } catch (error) {
      logger.error('Failed to get share metrics', { error });
      next(error);
    }
  });

  /**
   * Get metrics for a specific share
   */
  router.get('/shares/:shareId', requireMetrics, async (req, res, next) => {
    try {
      const { shareId } = req.params;
      const { timespan = '24h', granularity, organizationId } = req.query;
      if (!organizationId) {
        return res.status(403).json({ error: 'Organization ID is required' });
      }
      const effectiveGranularity =
        (granularity as string) || getOptimalGranularity(timespan as string);
      const options: MetricsQueryOptions = {
        timespan: timespan as any,
        granularity: effectiveGranularity as any,
      };
      const data = await aggregationEngine!.getShareMetrics(
        organizationId as string,
        shareId,
        options
      );
      res.json(data);
    } catch (error) {
      logger.error('Failed to get share metrics', { shareId: req.params.shareId, error });
      next(error);
    }
  });

  /**
   * @swagger
   * /api/metrics/models/{modelId}:
   *   get:
   *     summary: Get metrics for a specific model
   *     parameters:
   *       - in: path
   *         name: modelId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: timespan
   *         schema:
   *           type: string
   *           enum: [1h, 24h, 7d, 30d, 90d, 1y]
   *           default: 24h
   *       - in: query
   *         name: granularity
   *         schema:
   *           type: string
   *           enum: [hour, day, week, month]
   *     responses:
   *       200:
   *         description: Model metrics data
   *       400:
   *         description: Invalid parameters
   *       503:
   *         description: Metrics service not available
   */
  router.get('/models/:modelId', requireMetrics, async (req, res, next) => {
    try {
      const { modelId } = req.params;
      const { timespan = '24h', granularity, organizationId } = req.query;

      // Require organizationId for security - prevent cross-org data exposure
      if (!organizationId) {
        return res.status(403).json({
          error: 'Organization ID is required',
          message: 'Please provide organizationId query parameter to access model metrics',
        });
      }

      // Validate parameters
      if (!validateTimespan(timespan as string)) {
        return res.status(400).json({
          error: 'Invalid timespan',
          validValues: ['1h', '24h', '7d', '30d', '90d', '1y'],
        });
      }

      const effectiveGranularity =
        (granularity as string) || getOptimalGranularity(timespan as string);
      if (!validateGranularity(effectiveGranularity)) {
        return res.status(400).json({
          error: 'Invalid granularity',
          validValues: ['hour', 'day', 'week', 'month'],
        });
      }

      const options: MetricsQueryOptions = {
        timespan: timespan as any,
        granularity: effectiveGranularity as any,
      };

      const result = await aggregationEngine!.getOrganizationModelMetrics(
        organizationId as string,
        modelId,
        options
      );
      res.json(result);
    } catch (error) {
      logger.error('Failed to get model metrics', { modelId: req.params.modelId, error });
      next(error);
    }
  });

  /**
   * @swagger
   * /api/metrics/providers/{providerId}:
   *   get:
   *     summary: Get metrics for a specific provider
   *     parameters:
   *       - in: path
   *         name: providerId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: timespan
   *         schema:
   *           type: string
   *           enum: [1h, 24h, 7d, 30d, 90d, 1y]
   *           default: 24h
   *       - in: query
   *         name: granularity
   *         schema:
   *           type: string
   *           enum: [hour, day, week, month]
   *     responses:
   *       200:
   *         description: Provider metrics data
   *       400:
   *         description: Invalid parameters
   *       503:
   *         description: Metrics service not available
   */
  router.get('/providers/:providerId', requireMetrics, async (req, res, next) => {
    try {
      const { providerId } = req.params;
      const { timespan = '24h', granularity, organizationId } = req.query;

      if (!organizationId) {
        return res.status(403).json({
          error: 'Organization ID is required',
          message: 'Please provide organizationId query parameter to access provider metrics',
        });
      }

      if (!validateTimespan(timespan as string)) {
        return res.status(400).json({
          error: 'Invalid timespan',
          validValues: ['1h', '24h', '7d', '30d', '90d', '1y'],
        });
      }

      const effectiveGranularity =
        (granularity as string) || getOptimalGranularity(timespan as string);
      if (!validateGranularity(effectiveGranularity)) {
        return res.status(400).json({
          error: 'Invalid granularity',
          validValues: ['hour', 'day', 'week', 'month'],
        });
      }

      const options: MetricsQueryOptions = {
        timespan: timespan as any,
        granularity: effectiveGranularity as any,
      };

      const result = await aggregationEngine!.getOrganizationProviderMetrics(
        organizationId as string,
        providerId,
        options
      );
      res.json(result);
    } catch (error) {
      logger.error('Failed to get provider metrics', { providerId: req.params.providerId, error });
      next(error);
    }
  });

  /**
   * @swagger
   * /api/metrics/users/{userId}:
   *   get:
   *     summary: Get metrics for a specific user
   *     parameters:
   *       - in: path
   *         name: userId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: timespan
   *         schema:
   *           type: string
   *           enum: [1h, 24h, 7d, 30d, 90d, 1y]
   *           default: 24h
   *       - in: query
   *         name: granularity
   *         schema:
   *           type: string
   *           enum: [hour, day, week, month]
   *     responses:
   *       200:
   *         description: User metrics data
   *       400:
   *         description: Invalid parameters
   *       503:
   *         description: Metrics service not available
   */
  router.get('/users/:userId', requireMetrics, async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { timespan = '24h', granularity, organizationId } = req.query;

      // Require organizationId for security - prevent cross-org data exposure
      if (!organizationId) {
        return res.status(403).json({
          error: 'Organization ID is required',
          message: 'Please provide organizationId query parameter to access user metrics',
        });
      }

      if (!validateTimespan(timespan as string)) {
        return res.status(400).json({
          error: 'Invalid timespan',
          validValues: ['1h', '24h', '7d', '30d', '90d', '1y'],
        });
      }

      const effectiveGranularity =
        (granularity as string) || getOptimalGranularity(timespan as string);
      if (!validateGranularity(effectiveGranularity)) {
        return res.status(400).json({
          error: 'Invalid granularity',
          validValues: ['hour', 'day', 'week', 'month'],
        });
      }

      const options: MetricsQueryOptions = {
        timespan: timespan as any,
        granularity: effectiveGranularity as any,
      };

      const result = await aggregationEngine!.getOrganizationUserMetrics(
        organizationId as string,
        userId,
        options
      );
      res.json(result);
    } catch (error) {
      logger.error('Failed to get user metrics', { userId: req.params.userId, error });
      next(error);
    }
  });

  /**
   * @swagger
   * /api/metrics/organizations/{organizationId}:
   *   get:
   *     summary: Get metrics for a specific organization
   *     parameters:
   *       - in: path
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: timespan
   *         schema:
   *           type: string
   *           enum: [1h, 24h, 7d, 30d, 90d, 1y]
   *           default: 24h
   *       - in: query
   *         name: granularity
   *         schema:
   *           type: string
   *           enum: [hour, day, week, month]
   *     responses:
   *       200:
   *         description: Organization metrics data
   *       400:
   *         description: Invalid parameters
   *       503:
   *         description: Metrics service not available
   */
  router.get('/organizations/:organizationId', requireMetrics, async (req, res, next) => {
    try {
      const { organizationId } = req.params;
      const { timespan = '24h', granularity } = req.query;

      if (!validateTimespan(timespan as string)) {
        return res.status(400).json({
          error: 'Invalid timespan',
          validValues: ['1h', '24h', '7d', '30d', '90d', '1y'],
        });
      }

      const effectiveGranularity =
        (granularity as string) || getOptimalGranularity(timespan as string);
      if (!validateGranularity(effectiveGranularity)) {
        return res.status(400).json({
          error: 'Invalid granularity',
          validValues: ['hour', 'day', 'week', 'month'],
        });
      }

      const options: MetricsQueryOptions = {
        timespan: timespan as any,
        granularity: effectiveGranularity as any,
      };

      const result = await aggregationEngine!.getOrganizationMetrics(organizationId, options);
      res.json(result);
    } catch (error) {
      logger.error('Failed to get organization metrics', {
        organizationId: req.params.organizationId,
        error,
      });
      next(error);
    }
  });

  /**
   * @swagger
   * /api/metrics/dashboard:
   *   get:
   *     summary: Get dashboard summary data with top models, users, and trends
   *     parameters:
   *       - in: query
   *         name: timespan
   *         schema:
   *           type: string
   *           enum: [1h, 24h, 7d, 30d, 90d, 1y]
   *           default: 24h
   *       - in: query
   *         name: organizationId
   *         schema:
   *           type: string
   *         description: Organization ID to filter metrics (required for non-admin users)
   *     responses:
   *       200:
   *         description: Dashboard metrics data
   *       400:
   *         description: Invalid parameters
   *       403:
   *         description: Missing required organizationId
   *       503:
   *         description: Metrics service not available
   */
  router.get('/dashboard', requireMetrics, async (req, res, next) => {
    try {
      const { timespan = '24h', organizationId } = req.query;

      // Require organizationId for security - prevent cross-org data exposure
      if (!organizationId) {
        return res.status(403).json({
          error: 'Organization ID is required',
          message: 'Please provide organizationId query parameter to access metrics',
        });
      }

      if (!validateTimespan(timespan as string)) {
        return res.status(400).json({
          error: 'Invalid timespan',
          validValues: ['1h', '24h', '7d', '30d', '90d', '1y'],
        });
      }

      const granularity = getOptimalGranularity(timespan as string);
      const options: MetricsQueryOptions = {
        timespan: timespan as any,
        granularity: granularity as any,
      };

      const result = await aggregationEngine!.getDashboardData(options, organizationId as string);
      res.json(result);
    } catch (error) {
      logger.error('Failed to get dashboard metrics', {
        timespan: req.query.timespan,
        organizationId: req.query.organizationId,
        error,
      });
      next(error);
    }
  });

  /**
   * Get metrics configuration
   */
  router.get('/config', async (req, res, next) => {
    try {
      const config = loadMetricsConfiguration();
      res.json({
        enabled: config.enabled,
        retention_seconds: config.retentionPeriodSeconds,
        dimensions: config.dimensions,
        aggregation_intervals: config.aggregationIntervals,
      });
    } catch (error) {
      logger.error('Failed to get metrics configuration', { error });
      next(error);
    }
  });

  /**
   * Health check for metrics service
   */
  router.get('/health', async (req, res, _next) => {
    try {
      if (!aggregationEngine) {
        return res.status(503).json({
          status: 'unavailable',
          message: 'Metrics service not initialized',
        });
      }

      // Test Redis connectivity
      await redis.ping();

      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      });
    } catch (error) {
      logger.error('Metrics health check failed', { error });
      res.status(503).json({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
