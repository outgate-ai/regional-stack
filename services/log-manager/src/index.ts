import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import Redis from 'ioredis';
import crypto from 'crypto';
import { brotliDecompressSync } from 'zlib';
import { requiredEnv, parseEnvInt } from '@outgate/shared';
import { logRouter, AlertWebhookConfig } from './routes/logs';
import { statsRouter } from './routes/stats';
import { metricsRouter } from './routes/metrics';
import { errorHandler } from './middleware/error';

const logger = pino({
  level: process.env.PINO_LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: { colorize: true },
        }
      : undefined,
});

const REDIS_RETRY_BASE_MS = parseInt(process.env.REDIS_RETRY_BASE_MS || '50');
const REDIS_RETRY_MAX_MS = parseInt(process.env.REDIS_RETRY_MAX_MS || '2000');

const redis = new Redis(requiredEnv('REDIS_URL'), {
  retryStrategy: (times) => Math.min(times * REDIS_RETRY_BASE_MS, REDIS_RETRY_MAX_MS),
});

// Alert webhook config — forwards alerts to the global BFF via HMAC-signed HTTP
const alertWebhook: AlertWebhookConfig | undefined = process.env.ALERT_WEBHOOK_URL
  ? {
      url: process.env.ALERT_WEBHOOK_URL,
      secret: process.env.WEBHOOK_SECRET || '',
      regionId: process.env.REGION_ID || '',
      organizationId: process.env.ORGANIZATION_ID || '',
    }
  : undefined;

const MAX_REQUEST_SIZE = process.env.MAX_REQUEST_SIZE || '10mb';

const app = express();
const port = parseEnvInt(process.env.SERVICE_PORT, 4001);

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Log Manager API',
      version: '1.0.0',
      description: 'API for log ingestion and querying',
    },
    servers: [
      {
        url: `http://localhost:${port}`,
      },
    ],
  },
  apis: ['./src/routes/*.ts'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

app.use(helmet());
app.use(cors());

// First, handle raw body for Brotli-compressed requests
app.use(
  express.raw({
    limit: MAX_REQUEST_SIZE,
    type: (req) => {
      // Capture raw body for Brotli-compressed requests
      return req.headers['content-encoding'] === 'br';
    },
  })
);

// Middleware to decompress Brotli content
app.use((req, res, next) => {
  if (req.headers['content-encoding'] === 'br' && Buffer.isBuffer(req.body)) {
    try {
      const decompressed = brotliDecompressSync(req.body);
      req.body = JSON.parse(decompressed.toString());
      // Remove content-encoding header so downstream doesn't try to decompress again
      delete req.headers['content-encoding'];
    } catch (error) {
      logger.error('Failed to decompress Brotli content', { error });
      return res.status(400).json({ error: 'Failed to decompress request body' });
    }
  }
  next();
});

// Then handle regular JSON
app.use(express.json({ limit: MAX_REQUEST_SIZE }));
app.use(pinoHttp({
  logger,
  genReqId: () => crypto.randomUUID(),
  // Silence health check endpoint logs
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/metrics/health',
  },
  // Strip verbose headers from logs
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      remoteAddress: req.remoteAddress,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
}));

app.get('/health', async (req, res) => {
  try {
    await redis.ping();
    res.json({ status: 'ok', service: 'log-manager' });
  } catch {
    res.status(503).json({ status: 'error', service: 'log-manager' });
  }
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/logs', logRouter(redis, logger, alertWebhook));
app.use('/stats', statsRouter(redis, logger));
app.use('/metrics', metricsRouter(redis, logger));
app.use(errorHandler);

async function start() {
  try {
    await redis.ping();
    logger.info('Connected to Redis');

    app.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Log Manager service started');
    });
  } catch (error) {
    logger.error(error, 'Failed to start service');
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  redis.disconnect();
  process.exit(0);
});

start();
