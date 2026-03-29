import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pino from 'pino';
import { validateRoutes } from './routes/validate';
import { healthRoutes } from './routes/health';
import { errorHandler } from './middleware/error';
import { config, validateConfig } from './utils/config';

// Validate configuration on startup
try {
  validateConfig();
} catch (error) {
  console.error(
    'Configuration validation failed:',
    error instanceof Error ? error.message : 'Unknown error'
  );
  process.exit(1);
}

const app = express();
const logger = pino({ level: config.logLevel });

// Security and basic middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: config.maxRequestSize }));

// Routes
app.use('/validate', validateRoutes(logger));
app.use('/health', healthRoutes(logger));

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'guardrail',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
  });
});

// Error handling
app.use(errorHandler(logger));

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.originalUrl,
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

// Start server
app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      llmProvider: config.llm.provider,
      llmModel: config.llm.model,
    },
    `Guardrail service listening on port ${config.port}`
  );
});

export default app;
