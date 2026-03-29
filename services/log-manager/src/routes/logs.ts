import { Router } from 'express';
import Redis from 'ioredis';
import { Logger } from 'pino';
import { LogEntrySchema, LogQuerySchema } from '@outgate/shared';
import crypto from 'crypto';
import { parseResponseBody, detectEncoding } from '../utils/compression';
import { MetricsCollector } from '../services/MetricsCollector';
import { MetricsQueue } from '../services/MetricsQueue';
import { loadMetricsConfiguration } from '../config/metrics';

export interface AlertWebhookConfig {
  url: string;
  secret: string;
  regionId: string;
  organizationId: string;
}

export function logRouter(redis: Redis, logger: Logger, alertWebhook?: AlertWebhookConfig): Router {
  const router = Router();

  // Initialize metrics collection and queue
  let metricsQueue: MetricsQueue | null = null;
  try {
    const metricsConfig = loadMetricsConfiguration();
    if (metricsConfig.enabled) {
      const metricsCollector = new MetricsCollector(redis, logger, metricsConfig);
      metricsQueue = new MetricsQueue(redis, logger, metricsCollector);

      // Start the queue processor
      metricsQueue.start().catch((error) => {
        logger.error('Failed to start metrics queue', { error });
      });

      logger.info('Metrics collection enabled with async processing', {
        retention: `${metricsConfig.retentionPeriodSeconds}s`,
        dimensions: metricsConfig.dimensions,
      });
    } else {
      logger.info('Metrics collection disabled');
    }
  } catch (error) {
    logger.error('Failed to initialize metrics system', { error });
  }

  /**
   * @swagger
   * /logs:
   *   post:
   *     summary: Ingest a log entry
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               userId:
   *                 type: string
   *               level:
   *                 type: string
   *                 enum: [info, warn, error, debug]
   *               message:
   *                 type: string
   *               source:
   *                 type: string
   *               meta:
   *                 type: object
   */
  router.post('/', async (req, res, next) => {
    try {
      const data = LogEntrySchema.parse(req.body);
      const timestamp = data.timestamp || new Date();
      const logId = crypto.randomUUID();

      const logEntry = {
        id: logId,
        ...data,
        timestamp: timestamp.toISOString(),
      };

      await redis.xadd(
        'logs:stream',
        '*',
        'id',
        logId,
        'timestamp',
        logEntry.timestamp,
        'userId',
        logEntry.userId,
        'level',
        logEntry.level,
        'source',
        logEntry.source || '',
        'message',
        logEntry.message,
        'meta',
        JSON.stringify(logEntry.meta || {})
      );

      await redis.zadd('logs:index', Date.parse(logEntry.timestamp), logId);

      await redis.incr(`logs:count:${logEntry.level}`);
      await redis.incr(`logs:user:${logEntry.userId}`);

      const now = Date.now();
      await redis.zadd('logs:rate:1m', now, logId);
      await redis.expire('logs:rate:1m', 60);
      await redis.zadd('logs:rate:5m', now, logId);
      await redis.expire('logs:rate:5m', 300);
      await redis.zadd('logs:rate:60m', now, logId);
      await redis.expire('logs:rate:60m', 3600);

      res.status(201).json({ id: logId });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @swagger
   * /logs:
   *   get:
   *     summary: Query log entries
   *     parameters:
   *       - in: query
   *         name: userId
   *         schema:
   *           type: string
   *       - in: query
   *         name: level
   *         schema:
   *           type: string
   *           enum: [info, warn, error, debug]
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           default: 100
   *       - in: query
   *         name: since
   *         schema:
   *           type: string
   */
  router.get('/', async (req, res, next) => {
    try {
      // Transform query parameters to correct types
      const queryParams = {
        ...req.query,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 100,
      };
      const query = LogQuerySchema.parse(queryParams);
      const { userId, level, limit = 100, since } = query;

      let logIds: string[] = [];

      if (since) {
        const sinceTimestamp = Date.parse(since);
        logIds = await redis.zrangebyscore('logs:index', sinceTimestamp, '+inf', 'LIMIT', 0, limit);
      } else {
        logIds = await redis.zrevrange('logs:index', 0, limit - 1);
      }

      const logs = [];
      for (const logId of logIds) {
        const entries = await redis.xrange('logs:stream', '-', '+', 'COUNT', 1000);

        for (const [, fields] of entries) {
          const fieldMap: any = {};
          for (let i = 0; i < fields.length; i += 2) {
            fieldMap[fields[i]] = fields[i + 1];
          }

          if (fieldMap.id === logId) {
            const log = {
              id: fieldMap.id,
              timestamp: fieldMap.timestamp,
              userId: fieldMap.userId,
              level: fieldMap.level,
              source: fieldMap.source || undefined,
              message: fieldMap.message,
              meta: JSON.parse(fieldMap.meta || '{}'),
            };

            if ((!userId || log.userId === userId) && (!level || log.level === level)) {
              logs.push(log);
            }
            break;
          }
        }

        if (logs.length >= limit) break;
      }

      res.json(logs);
    } catch (error) {
      next(error);
    }
  });

  /**
   * HTTP Log endpoint for Kong HTTP-Log plugin
   * Receives request/response data from Kong gateway
   */
  router.post('/http', async (req, res, next) => {
    try {
      const httpLogData = req.body;
      const logId = crypto.randomUUID();
      const timestamp = new Date().toISOString();

      // Process response body with decompression if needed
      let processedResponseBody =
        httpLogData.response_body || JSON.stringify(httpLogData.response?.body || {});
      let compressionInfo: any = null;

      // Decode Base64 response body if needed
      let responseBodyData = httpLogData.response_body;
      const bodyEncoding = httpLogData.response_body_encoding;
      // Decode base64-encoded response bodies (compressed or binary data)
      if (
        bodyEncoding &&
        (bodyEncoding === 'base64' ||
          bodyEncoding === 'base64_compressed' ||
          bodyEncoding === 'base64_binary') &&
        httpLogData.response_body
      ) {
        try {
          responseBodyData = Buffer.from(httpLogData.response_body, 'base64');

        } catch (error) {
          logger.warn('Failed to decode Base64 response body', { error, bodyEncoding });
          responseBodyData = httpLogData.response_body;
        }
      }

      if (responseBodyData && httpLogData.response?.headers) {
        const contentEncoding = detectEncoding(httpLogData.response.headers);

        if (contentEncoding) {
          const parseResult = parseResponseBody(responseBodyData, httpLogData.response.headers);
          processedResponseBody = parseResult.raw;
          compressionInfo = {
            encoding: contentEncoding,
            success: parseResult.success,
            compressionInfo: parseResult.compressionInfo,
            originalSize: Buffer.isBuffer(responseBodyData)
              ? responseBodyData.length
              : responseBodyData.length,
            processedSize: parseResult.raw.length,
          };


        }
      }

      // Get organizationId from multiple sources (custom field, header, or consumer)
      // Priority: custom field (set by Kong pre-function) > request header > x-outgate-org > consumer org prefix
      const rawOrganizationId =
        (httpLogData as any).organization_id ||
        httpLogData.request?.headers?.['x-organization-id'] ||
        httpLogData.request?.headers?.['x-org-id'] ||
        httpLogData.request?.headers?.['x-outgate-org'] ||
        '';

      // Fallback: extract org prefix from consumer custom_id (format: {orgSlug}-ak-{keyId})
      let organizationId = rawOrganizationId;
      if (!organizationId && httpLogData.consumer?.custom_id) {
        const customId = httpLogData.consumer.custom_id;
        if (customId.startsWith('o-')) {
          const akIdx = customId.indexOf('-ak-');
          organizationId = akIdx > 0 ? customId.slice(0, akIdx) : '';
        }
      }

      // Extract providerId from Kong service name (format: {orgId}-{providerSlug})
      // Strip the org prefix to get just the provider slug
      const serviceName = httpLogData.service?.name || '';
      const orgPrefix = organizationId ? `${organizationId}-` : '';
      const providerId = orgPrefix && serviceName.startsWith(orgPrefix)
        ? serviceName.slice(orgPrefix.length)
        : serviceName;

      // Extract correlation ID from custom field or request header
      const correlationId =
        (httpLogData as any).correlation_id ||
        httpLogData.request?.headers?.['x-correlation-id'] ||
        '';

      // Extract key information from Kong's HTTP log
      // Strip sensitive headers before storage
      const SENSITIVE_HEADERS = ['x-api-key', 'api-key', 'api_key', 'authorization',
        'x-internal-api-key', 'cookie', 'set-cookie', 'x-credential-identifier'];
      const redactHeaders = (headers: Record<string, any>) => {
        if (!headers) return {};
        const safe = { ...headers };
        for (const key of SENSITIVE_HEADERS) {
          if (safe[key]) {
            const val = String(safe[key]);
            safe[key] = val.length > 4 ? `${val.slice(0, 4)}...[REDACTED]` : '[REDACTED]';
          }
        }
        return safe;
      };

      const rawApiKey = httpLogData.request?.headers?.['x-api-key'] || '';

      const logEntry = {
        id: logId,
        timestamp,
        method: httpLogData.request?.method || 'UNKNOWN',
        path: httpLogData.request?.uri || '',
        status: httpLogData.response?.status || 0,
        latency: httpLogData.latencies?.request || 0,
        userAgent: httpLogData.request?.headers?.['user-agent'] || '',
        apiKey: rawApiKey.length > 4 ? `${rawApiKey.slice(0, 4)}...[REDACTED]` : rawApiKey,
        providerId,
        organizationId,
        correlationId,
        requestHeaders: JSON.stringify(redactHeaders(httpLogData.request?.headers || {})),
        responseHeaders: JSON.stringify(redactHeaders(httpLogData.response?.headers || {})),
        requestBody: httpLogData.request_body || JSON.stringify(httpLogData.request?.body || {}),
        responseBody: processedResponseBody,
        requestSize: httpLogData.request?.size || 0,
        responseSize: httpLogData.response?.size || 0,
        compressionInfo: compressionInfo ? JSON.stringify(compressionInfo) : '',
      };

      // Only store logs for actual providers (skip system services like BFF, user-manager, log-manager)
      const systemServices = ['bff', 'user-manager', 'log-manager'];
      if (!logEntry.providerId || systemServices.includes(logEntry.providerId)) {
        res.status(200).json({ success: true, skipped: true });
        return;
      }

      // Get TTL for this provider (default 24 hours)
      const defaultTTL = parseInt(process.env.LOG_DEFAULT_TTL_SECONDS || String(24 * 60 * 60)); // 1 day in seconds
      const providerTTLKey = logEntry.organizationId
        ? `provider_config:${logEntry.organizationId}:${logEntry.providerId}:log_ttl`
        : `provider_config:${logEntry.providerId}:log_ttl`;
      const providerTTL = await redis.get(providerTTLKey);
      const ttlSeconds = providerTTL ? parseInt(providerTTL) : defaultTTL;

      // Extract model — prefer dedicated field from Kong, fall back to parsing body
      let model = '';
      if ((httpLogData as any).request_model) {
        model = (httpLogData as any).request_model;
      } else {
        try {
          const parsedReqBody = typeof logEntry.requestBody === 'string'
            ? JSON.parse(logEntry.requestBody) : logEntry.requestBody;
          model = parsedReqBody?.model || parsedReqBody?.messages?.[0]?.model || '';
        } catch { /* ignore parse errors */ }
      }

      // Store bodies in separate Redis keys (keeps hash lightweight for list queries)
      const logKey = `http_logs:entry:${logId}`;
      const reqBodyKey = `http_logs:body:${logId}:req`;
      const resBodyKey = `http_logs:body:${logId}:res`;

      if (logEntry.requestBody) {
        await redis.set(reqBodyKey, logEntry.requestBody, 'EX', ttlSeconds);
      }
      if (logEntry.responseBody) {
        await redis.set(resBodyKey, logEntry.responseBody, 'EX', ttlSeconds);
      }

      // Store metadata hash (no bodies — fetch via /logs/http/:id/body)
      await redis.hset(
        logKey,
        'id',
        logId,
        'timestamp',
        timestamp,
        'method',
        logEntry.method,
        'path',
        logEntry.path,
        'status',
        logEntry.status.toString(),
        'latency',
        logEntry.latency.toString(),
        'userAgent',
        logEntry.userAgent,
        'apiKey',
        logEntry.apiKey,
        'providerId',
        logEntry.providerId,
        'organizationId',
        logEntry.organizationId,
        'correlationId',
        logEntry.correlationId,
        'model',
        model,
        'requestHeaders',
        logEntry.requestHeaders,
        'responseHeaders',
        logEntry.responseHeaders,
        'requestSize',
        logEntry.requestSize.toString(),
        'responseSize',
        logEntry.responseSize.toString(),
        'requestBodySize',
        (logEntry.requestBody?.length || 0).toString(),
        'responseBodySize',
        (logEntry.responseBody?.length || 0).toString(),
        'promptTokens',
        ((httpLogData as any).prompt_tokens || 0).toString(),
        'completionTokens',
        ((httpLogData as any).completion_tokens || 0).toString(),
        'compressionInfo',
        logEntry.compressionInfo
      );

      // Set TTL on the log entry
      await redis.expire(logKey, ttlSeconds);

      // Add to time-sorted index with TTL - use organization-scoped index for data isolation
      // Global index for admin purposes only
      await redis.zadd('http_logs:index', Date.parse(timestamp), logId);
      await redis.expire('http_logs:index', ttlSeconds);

      // Organization-specific index for secure data access
      if (logEntry.organizationId) {
        await redis.zadd(
          `http_logs:org:${logEntry.organizationId}:index`,
          Date.parse(timestamp),
          logId
        );
        await redis.expire(`http_logs:org:${logEntry.organizationId}:index`, ttlSeconds);
      }

      // Update stats
      await redis.incr(`http_logs:status:${logEntry.status}`);
      await redis.incr(`http_logs:method:${logEntry.method}`);
      if (logEntry.providerId) {
        await redis.incr(`http_logs:provider:${logEntry.providerId}`);
      }

      // Queue metrics processing if enabled
      if (metricsQueue) {
        try {
          const metricsJobId = await metricsQueue.addJob({
            request: {
              method: httpLogData.request?.method,
              uri: httpLogData.request?.uri,
              headers: httpLogData.request?.headers,
              body: httpLogData.request?.body || httpLogData.request_body,
              size: httpLogData.request?.size || logEntry.requestSize,
            },
            response: {
              status: httpLogData.response?.status,
              headers: httpLogData.response?.headers,
              body: httpLogData.response?.body || processedResponseBody,
              size: httpLogData.response?.size || logEntry.responseSize,
            },
            latencies: {
              request: httpLogData.latencies?.request,
              kong: httpLogData.latencies?.kong,
              proxy: httpLogData.latencies?.proxy,
            },
            service: {
              id: httpLogData.service?.id,
              name: httpLogData.service?.name,
            },
            consumer: {
              id: httpLogData.consumer?.id,
              custom_id: httpLogData.consumer?.custom_id,
            },
            started_at: httpLogData.started_at || Date.now(),
            request_model: httpLogData.request_model || model || undefined,
            // Organization ID from Kong HTTP log custom field (set by custom_fields_by_lua)
            organization_id: (httpLogData as any).organization_id || organizationId || undefined,
            // Guardrail fields (set by Kong Lua via kong.log.set_serialize_value)
            guardrail_latency_ms: (httpLogData as any).guardrail_latency_ms || undefined,
            guardrail_validated: (httpLogData as any).guardrail_validated || undefined,
            // Token counts (set by Kong Lua body_filter via kong.log.set_serialize_value)
            prompt_tokens: (httpLogData as any).prompt_tokens || undefined,
            completion_tokens: (httpLogData as any).completion_tokens || undefined,
            cache_read_tokens: (httpLogData as any).cache_read_tokens || undefined,
            cache_write_tokens: (httpLogData as any).cache_write_tokens || undefined,
            // Share tracking (set by Kong Lua when request comes through a shadow provider)
            share_id: (httpLogData as any).share_id || undefined,
            // Router upstream selection (set by router Lua scripts)
            selected_upstream: (httpLogData as any).selected_upstream || undefined,
          });

        } catch (metricsError) {
          // Don't fail the entire request if metrics queuing fails
          logger.error('Failed to queue metrics processing for HTTP log', {
            logId,
            error: metricsError,
          });
        }
      }

      res.status(200).json({ success: true, logId });
    } catch (error) {
      logger.error('Failed to store HTTP log', error);
      next(error);
    }
  });

  /**
   * Get HTTP logs for monitoring
   */
  router.get('/http', async (req, res, next) => {
    try {
      const { limit = 100, offset = 0, since, organizationId, providerId, status } = req.query;

      // Require organization ID for security - prevent cross-org data exposure
      if (!organizationId) {
        return res.status(403).json({
          error: 'Organization ID is required',
          message: 'Please provide organizationId query parameter to access logs',
        });
      }

      let logIds: string[] = [];
      const offsetNum = Number(offset);
      const limitNum = Number(limit);

      // Use organization-scoped index for secure data isolation
      const indexKey = `http_logs:org:${organizationId}:index`;

      if (since) {
        const sinceTimestamp = Date.parse(since as string);
        logIds = await redis.zrangebyscore(
          indexKey,
          sinceTimestamp,
          '+inf',
          'LIMIT',
          offsetNum,
          limitNum
        );
      } else {
        logIds = await redis.zrevrange(indexKey, offsetNum, offsetNum + limitNum - 1);
      }

      // Use pipeline for efficient batch retrieval
      const pipeline = redis.pipeline();
      for (const logId of logIds) {
        pipeline.hgetall(`http_logs:entry:${logId}`);
      }
      const results = await pipeline.exec();

      const logs = [];
      for (const [err, fieldMap] of results || []) {
        if (
          err ||
          !fieldMap ||
          typeof fieldMap !== 'object' ||
          Object.keys(fieldMap).length === 0
        ) {
          continue; // Skip missing or deleted logs
        }

        // Type assertion for Redis hash map
        const logData = fieldMap as Record<string, string>;

        const log = {
          id: logData.id,
          timestamp: logData.timestamp,
          method: logData.method,
          path: logData.path,
          status: parseInt(logData.status),
          latency: parseInt(logData.latency),
          userAgent: logData.userAgent,
          apiKey: logData.apiKey,
          providerId: logData.providerId,
          organizationId: logData.organizationId,
          model: logData.model || '',
          requestHeaders: JSON.parse(logData.requestHeaders || '{}'),
          responseHeaders: JSON.parse(logData.responseHeaders || '{}'),
          requestSize: parseInt(logData.requestSize),
          responseSize: parseInt(logData.responseSize),
          requestBodySize: parseInt(logData.requestBodySize || '0'),
          responseBodySize: parseInt(logData.responseBodySize || '0'),
          promptTokens: parseInt(logData.promptTokens || '0'),
          completionTokens: parseInt(logData.completionTokens || '0'),
          compressionInfo: (() => {
            try {
              return logData.compressionInfo ? JSON.parse(logData.compressionInfo) : null;
            } catch {
              return null;
            }
          })(),
        };

        // Apply filters (organization filtering already done via index)
        // Only need to filter by providerId and status now
        if (providerId && log.providerId !== providerId) continue;
        if (status && log.status !== parseInt(status as string)) continue;

        logs.push(log);

        if (logs.length >= Number(limit)) break;
      }

      res.json(logs);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Get request/response body for a specific log entry
   */
  router.get('/http/:id/body', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { organizationId } = req.query;

      if (!organizationId) {
        return res.status(403).json({ error: 'Organization ID is required' });
      }

      // Verify the log belongs to this org
      const logOrgId = await redis.hget(`http_logs:entry:${id}`, 'organizationId');
      if (!logOrgId || logOrgId !== organizationId) {
        return res.status(404).json({ error: 'Log entry not found' });
      }

      // Try separate body keys first (new format), fall back to hash fields (old format)
      let [requestBody, responseBody] = await Promise.all([
        redis.get(`http_logs:body:${id}:req`),
        redis.get(`http_logs:body:${id}:res`),
      ]);

      // Backward compatibility: fall back to inline hash fields for old logs
      if (requestBody === null && responseBody === null) {
        const [hashReqBody, hashResBody] = await Promise.all([
          redis.hget(`http_logs:entry:${id}`, 'requestBody'),
          redis.hget(`http_logs:entry:${id}`, 'responseBody'),
        ]);
        requestBody = hashReqBody;
        responseBody = hashResBody;
      }

      const parseBody = (raw: string | null) => {
        if (!raw) return {};
        try { return JSON.parse(raw); } catch { return raw; }
      };

      res.json({
        id,
        requestBody: parseBody(requestBody),
        responseBody: parseBody(responseBody),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Configure TTL for a specific provider's logs
   */
  router.post('/config/:providerId/ttl', async (req, res, next) => {
    try {
      const { providerId } = req.params;
      const { ttlSeconds } = req.body;

      const ttlMin = parseInt(process.env.LOG_TTL_MIN_SECONDS || '3600');
      const ttlMax = parseInt(process.env.LOG_TTL_MAX_SECONDS || String(30 * 24 * 60 * 60));
      if (!ttlSeconds || ttlSeconds < ttlMin || ttlSeconds > ttlMax) {
        return res.status(400).json({
          error: `TTL must be between ${ttlMin}s and ${ttlMax}s`,
        });
      }

      await redis.set(`provider_config:${providerId}:log_ttl`, ttlSeconds.toString());

      logger.info('Updated log TTL for provider', { providerId, ttlSeconds });
      res.json({ success: true, providerId, ttlSeconds });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Get TTL configuration for a specific provider
   */
  router.get('/config/:providerId/ttl', async (req, res, next) => {
    try {
      const { providerId } = req.params;
      const defaultTTL = parseInt(process.env.LOG_DEFAULT_TTL_SECONDS || String(24 * 60 * 60));

      const providerTTL = await redis.get(`provider_config:${providerId}:log_ttl`);
      const ttlSeconds = providerTTL ? parseInt(providerTTL) : defaultTTL;

      res.json({ providerId, ttlSeconds, isDefault: !providerTTL });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @swagger
   * /logs/alerts:
   *   post:
   *     summary: Create security alert from guardrail service
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               providerId:
   *                 type: string
   *               organizationId:
   *                 type: string
   *               requestId:
   *                 type: string
   *               method:
   *                 type: string
   *               path:
   *                 type: string
   *               severity:
   *                 type: string
   *                 enum: [low, medium, high, critical]
   *               reason:
   *                 type: string
   *               problematicContent:
   *                 type: string
   *               userAgent:
   *                 type: string
   *               clientIp:
   *                 type: string
   *     responses:
   *       201:
   *         description: Alert created successfully
   *       400:
   *         description: Invalid request data
   *       500:
   *         description: Internal server error
   */
  router.post('/alerts', async (req, res, next) => {
    try {
      const {
        providerId,
        organizationId,
        requestId,
        method,
        path,
        severity = 'high',
        reason,
        problematicContent,
        userAgent,
        clientIp,
        detections,
      } = req.body;

      // Validate required fields
      if (!providerId || !organizationId || !reason) {
        return res.status(400).json({
          error: 'Missing required fields: providerId, organizationId, reason',
        });
      }

      // Validate severity
      if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
        return res.status(400).json({
          error: 'Invalid severity level. Must be one of: low, medium, high, critical',
        });
      }

      if (!alertWebhook?.url) {
        logger.warn('Alert webhook not configured');
        return res.status(500).json({ error: 'Alert webhook not configured' });
      }

      // Forward alert to BFF via HMAC-signed webhook
      // DO NOT send anonymizationMap - it contains original sensitive values
      // organizationId = region owner org (needed for HMAC verification / region lookup)
      // alertOrganizationId = requesting user's org (for alert ownership / scoping)
      const alertPayload = {
        regionId: alertWebhook.regionId,
        organizationId: alertWebhook.organizationId || organizationId,
        alertOrganizationId: organizationId,
        providerId,
        requestId: requestId || crypto.randomUUID(),
        method: method || 'UNKNOWN',
        path: path || '/',
        severity,
        reason,
        problematicContent: problematicContent || '',
        userAgent: userAgent || null,
        clientIp: clientIp || null,
        detections: detections || null,
      };

      const body = JSON.stringify(alertPayload);
      const signature = crypto.createHmac('sha256', alertWebhook.secret).update(body).digest('hex');

      const response = await fetch(alertWebhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Region-Id': alertWebhook.regionId,
        },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Alert webhook responded with ${response.status}: ${errorText}`);
      }

      const result = await response.json() as { received: boolean; alertId: string };

      logger.info('Security alert created', {
        alertId: result.alertId,
        providerId,
        organizationId,
        severity,
        reason,
      });

      res.status(201).json({
        success: true,
        alertId: result.alertId,
        message: 'Alert created successfully',
      });
    } catch (error) {
      logger.error('Failed to create alert', { error });
      next(error);
    }
  });

  /**
   * Get metrics queue statistics
   */
  router.get('/metrics/queue/stats', async (req, res, next) => {
    try {
      if (!metricsQueue) {
        return res.status(404).json({ error: 'Metrics queue not available' });
      }

      const stats = await metricsQueue.getStats();
      res.json(stats);
    } catch (error) {
      next(error);
    }
  });

  // =========================================================================
  // Guardrail Policy Storage (Redis)
  // =========================================================================

  /**
   * Store guardrail policy configuration in Redis
   */
  router.post('/guardrail/policies', async (req, res, next) => {
    try {
      const { policyId, organizationId, riskCategories } = req.body;

      if (!policyId || !organizationId || !riskCategories) {
        return res.status(400).json({
          error: 'Missing required fields: policyId, organizationId, riskCategories',
        });
      }

      const key = `guardrail_policy:${organizationId}:${policyId}`;
      await redis.set(key, JSON.stringify({ riskCategories }));

      logger.info('Guardrail policy stored', { policyId, organizationId });
      res.json({ success: true, policyId, organizationId });
    } catch (error) {
      logger.error('Failed to store guardrail policy', { error });
      next(error);
    }
  });

  /**
   * Get guardrail policy configuration from Redis
   */
  router.get('/guardrail/policies/:orgId/:policyId', async (req, res, next) => {
    try {
      const { orgId, policyId } = req.params;
      const key = `guardrail_policy:${orgId}:${policyId}`;
      const data = await redis.get(key);

      if (!data) {
        return res.status(404).json({ error: 'Policy not found' });
      }

      const parsed = JSON.parse(data);
      res.json(parsed);
    } catch (error) {
      logger.error('Failed to get guardrail policy', { error });
      next(error);
    }
  });

  /**
   * Delete guardrail policy configuration from Redis
   */
  router.delete('/guardrail/policies/:orgId/:policyId', async (req, res, next) => {
    try {
      const { orgId, policyId } = req.params;
      const key = `guardrail_policy:${orgId}:${policyId}`;
      await redis.del(key);

      logger.info('Guardrail policy deleted', { policyId, orgId });
      res.json({ success: true, policyId, orgId });
    } catch (error) {
      logger.error('Failed to delete guardrail policy', { error });
      next(error);
    }
  });

  // =========================================================================
  // Tool Monitoring Storage (Redis)
  // =========================================================================

  /**
   * Upsert tool definitions for a provider.
   * Accepts an array of tools extracted from request bodies.
   * Stores each tool as a Redis hash and maintains a sorted set index.
   */
  router.post('/tools', async (req, res, next) => {
    try {
      const { organizationId, providerId, tools } = req.body;

      if (!organizationId || !providerId || !Array.isArray(tools) || tools.length === 0) {
        return res.status(400).json({
          error: 'Missing required fields: organizationId, providerId, tools[]',
        });
      }

      const indexKey = `tools_index:${organizationId}:${providerId}`;
      const now = Date.now();
      let upserted = 0;

      for (const tool of tools) {
        if (!tool.name || !tool.toolHash) continue;

        const toolKey = `tool:${organizationId}:${providerId}:${tool.toolHash}`;
        const existing = await redis.get(toolKey);

        if (existing) {
          const parsed = JSON.parse(existing);
          parsed.lastSeen = now;
          parsed.callCount = (parsed.callCount || 0) + 1;
          if (tool.description) parsed.description = tool.description;
          if (tool.parameters) parsed.parameters = tool.parameters;
          if (tool.format) parsed.format = tool.format;
          await redis.set(toolKey, JSON.stringify(parsed));
        } else {
          await redis.set(
            toolKey,
            JSON.stringify({
              name: tool.name,
              toolHash: tool.toolHash,
              description: tool.description || '',
              parameters: tool.parameters || {},
              format: tool.format || 'unknown',
              firstSeen: now,
              lastSeen: now,
              callCount: 1,
            }),
          );
        }

        await redis.zadd(indexKey, now, tool.toolHash);
        upserted++;
      }

      res.json({ success: true, upserted });
    } catch (error) {
      logger.error('Failed to upsert tool definitions', { error });
      next(error);
    }
  });

  /**
   * List all tool definitions for a provider
   */
  router.get('/tools/:orgId/:providerId', async (req, res, next) => {
    try {
      const { orgId, providerId } = req.params;
      const sort = (req.query.sort as string) || 'lastSeen';
      const indexKey = `tools_index:${orgId}:${providerId}`;

      const toolHashes = await redis.zrevrange(indexKey, 0, -1);
      if (!toolHashes || toolHashes.length === 0) {
        return res.json({ tools: [] });
      }

      const tools: any[] = [];
      for (const hash of toolHashes) {
        const data = await redis.get(`tool:${orgId}:${providerId}:${hash}`);
        if (data) {
          tools.push(JSON.parse(data));
        }
      }

      if (sort === 'name') {
        tools.sort((a, b) => a.name.localeCompare(b.name));
      } else if (sort === 'callCount') {
        tools.sort((a, b) => b.callCount - a.callCount);
      }
      // default: lastSeen desc (already sorted by zrevrange)

      res.json({ tools });
    } catch (error) {
      logger.error('Failed to list tool definitions', { error });
      next(error);
    }
  });

  /**
   * Get a single tool definition detail
   */
  router.get('/tools/:orgId/:providerId/:toolHash', async (req, res, next) => {
    try {
      const { orgId, providerId, toolHash } = req.params;
      const toolKey = `tool:${orgId}:${providerId}:${toolHash}`;
      const data = await redis.get(toolKey);

      if (!data) {
        return res.status(404).json({ error: 'Tool not found' });
      }

      res.json(JSON.parse(data));
    } catch (error) {
      logger.error('Failed to get tool detail', { error });
      next(error);
    }
  });

  /**
   * Delete a single tool definition
   */
  router.delete('/tools/:orgId/:providerId/:toolHash', async (req, res, next) => {
    try {
      const { orgId, providerId, toolHash } = req.params;
      const toolKey = `tool:${orgId}:${providerId}:${toolHash}`;
      const indexKey = `tools_index:${orgId}:${providerId}`;

      await redis.del(toolKey);
      await redis.zrem(indexKey, toolHash);

      logger.info('Tool definition deleted', { providerId, toolHash, orgId });
      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to delete tool definition', { error });
      next(error);
    }
  });

  /**
   * Clear all tool definitions for a provider
   */
  router.delete('/tools/:orgId/:providerId', async (req, res, next) => {
    try {
      const { orgId, providerId } = req.params;
      const indexKey = `tools_index:${orgId}:${providerId}`;

      const toolHashes = await redis.zrange(indexKey, 0, -1);
      if (toolHashes && toolHashes.length > 0) {
        const keys = toolHashes.map((h: string) => `tool:${orgId}:${providerId}:${h}`);
        await redis.del(...keys);
      }
      await redis.del(indexKey);

      logger.info('All tool definitions cleared', { providerId, orgId, count: toolHashes?.length || 0 });
      res.json({ success: true, cleared: toolHashes?.length || 0 });
    } catch (error) {
      logger.error('Failed to clear tool definitions', { error });
      next(error);
    }
  });

  // Graceful shutdown handler for metrics queue
  process.on('SIGTERM', async () => {
    if (metricsQueue) {
      logger.info('Shutting down metrics queue...');
      await metricsQueue.stop();
    }
  });

  return router;
}
