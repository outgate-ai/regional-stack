#!/usr/bin/env node
/**
 * Migration script to re-index existing logs with organization-specific indices
 * This ensures data isolation for logs that were stored before the organization-scoped index feature
 */

import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({
  level: process.env.PINO_LOG_LEVEL || 'info',
});

async function migrateLogsToOrgIndices() {
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    maxRetriesPerRequest: 3,
  });

  try {
    logger.info('Starting migration of logs to organization-specific indices...');

    // Get all log IDs from the global index
    const logIds = await redis.zrange('http_logs:index', 0, -1);
    logger.info(`Found ${logIds.length} logs to migrate`);

    if (logIds.length === 0) {
      logger.info('No logs to migrate');
      return;
    }

    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Process each log
    for (const logId of logIds) {
      try {
        // Get the log entry
        const logData = await redis.hgetall(`http_logs:entry:${logId}`);

        if (!logData || Object.keys(logData).length === 0) {
          logger.warn(`Log entry not found: ${logId}`);
          skippedCount++;
          continue;
        }

        const organizationId = logData.organizationId;
        const timestamp = logData.timestamp;

        if (!organizationId) {
          logger.warn(`No organization ID for log: ${logId}`);
          skippedCount++;
          continue;
        }

        // Check if already in organization index
        const orgIndexKey = `http_logs:org:${organizationId}:index`;
        const exists = await redis.zscore(orgIndexKey, logId);

        if (exists !== null) {
          logger.debug(`Log ${logId} already in org index for ${organizationId}`);
          skippedCount++;
          continue;
        }

        // Add to organization-specific index
        await redis.zadd(orgIndexKey, Date.parse(timestamp), logId);

        // Set TTL on the organization index (matching the log entry TTL)
        const ttl = await redis.ttl(`http_logs:entry:${logId}`);
        if (ttl > 0) {
          await redis.expire(orgIndexKey, ttl);
        }

        migratedCount++;

        if (migratedCount % 100 === 0) {
          logger.info(`Migrated ${migratedCount} logs...`);
        }
      } catch (error) {
        logger.error(`Error migrating log ${logId}:`, error);
        errorCount++;
      }
    }

    logger.info('Migration completed:', {
      total: logIds.length,
      migrated: migratedCount,
      skipped: skippedCount,
      errors: errorCount,
    });

    // Verify migration by checking organization indices
    const orgIndices = await redis.keys('http_logs:org:*:index');
    logger.info(`Created/updated ${orgIndices.length} organization indices`);

    for (const indexKey of orgIndices) {
      const count = await redis.zcard(indexKey);
      const orgId = indexKey.match(/http_logs:org:(.+):index/)?.[1];
      logger.info(`Organization ${orgId}: ${count} logs`);
    }
  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await redis.quit();
  }
}

// Run the migration
migrateLogsToOrgIndices()
  .then(() => {
    logger.info('Migration script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Migration script failed:', error);
    process.exit(1);
  });
