import Redis from 'ioredis';
import { Logger } from 'pino';
import { MetricsCollector, HttpLogData } from './MetricsCollector';

interface QueueJob {
  id: string;
  type: 'process_metrics';
  data: HttpLogData;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  scheduledAt: number;
  lastError?: string;
}

interface QueueConfiguration {
  maxConcurrentJobs: number;
  maxAttempts: number;
  retryDelayMs: number;
  jobTimeoutMs: number;
  cleanupIntervalMs: number;
  maxCompletedAge: number; // Keep completed jobs for this long (ms)
  maxFailedAge: number; // Keep failed jobs for this long (ms)
}

interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  totalProcessed: number;
  avgProcessingTime: number;
  lastProcessedAt?: number;
}

export class MetricsQueue {
  private redis: Redis;
  private logger: Logger;
  private config: QueueConfiguration;
  private metricsCollector: MetricsCollector;
  private isProcessing = false;
  private processingInterval?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;
  private activeJobs = new Set<string>();

  private readonly QUEUE_PREFIX = 'metrics_queue';
  private readonly PENDING_QUEUE = `${this.QUEUE_PREFIX}:pending`;
  private readonly PROCESSING_QUEUE = `${this.QUEUE_PREFIX}:processing`;
  private readonly COMPLETED_QUEUE = `${this.QUEUE_PREFIX}:completed`;
  private readonly FAILED_QUEUE = `${this.QUEUE_PREFIX}:failed`;
  private readonly STATS_KEY = `${this.QUEUE_PREFIX}:stats`;
  private readonly JOB_DATA_PREFIX = `${this.QUEUE_PREFIX}:job`;

  constructor(
    redis: Redis,
    logger: Logger,
    metricsCollector: MetricsCollector,
    config?: Partial<QueueConfiguration>
  ) {
    this.redis = redis;
    this.logger = logger;
    this.metricsCollector = metricsCollector;

    this.config = {
      maxConcurrentJobs: parseInt(process.env.METRICS_MAX_CONCURRENT_JOBS || '10'),
      maxAttempts: parseInt(process.env.METRICS_MAX_ATTEMPTS || '3'),
      retryDelayMs: parseInt(process.env.METRICS_RETRY_DELAY_MS || '1000'),
      jobTimeoutMs: parseInt(process.env.METRICS_JOB_TIMEOUT_MS || '30000'),
      cleanupIntervalMs: parseInt(process.env.METRICS_CLEANUP_INTERVAL_MS || '60000'),
      maxCompletedAge: parseInt(process.env.METRICS_MAX_COMPLETED_AGE_MS || String(24 * 60 * 60 * 1000)),
      maxFailedAge: parseInt(process.env.METRICS_MAX_FAILED_AGE_MS || String(7 * 24 * 60 * 60 * 1000)),
      ...config,
    };
  }

  /**
   * Start the queue processing
   */
  async start(): Promise<void> {
    if (this.isProcessing) {
      this.logger.warn('Metrics queue is already running');
      return;
    }

    this.isProcessing = true;
    this.logger.info('Starting metrics queue processor', { config: this.config });

    // Recover any jobs that were processing when service went down
    await this.recoverStuckJobs();

    // Start processing loop
    const processingIntervalMs = parseInt(process.env.METRICS_PROCESSING_INTERVAL_MS || '100');
    this.processingInterval = setInterval(async () => {
      try {
        await this.processJobs();
      } catch (error) {
        this.logger.error('Error in queue processing loop', { error });
      }
    }, processingIntervalMs);

    // Start cleanup loop
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanup();
      } catch (error) {
        this.logger.error('Error in queue cleanup', { error });
      }
    }, this.config.cleanupIntervalMs);

    this.logger.info('Metrics queue processor started');
  }

  /**
   * Stop the queue processing
   */
  async stop(): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    this.isProcessing = false;

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    // Wait for active jobs to complete
    let attempts = 0;
    while (this.activeJobs.size > 0 && attempts < 50) {
      // Wait up to 5 seconds
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }

    this.logger.info('Metrics queue processor stopped', {
      activeJobsRemaining: this.activeJobs.size,
    });
  }

  /**
   * Add a job to the queue
   */
  async addJob(httpLogData: HttpLogData): Promise<string> {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const job: QueueJob = {
      id: jobId,
      type: 'process_metrics',
      data: httpLogData,
      attempts: 0,
      maxAttempts: this.config.maxAttempts,
      createdAt: Date.now(),
      scheduledAt: Date.now(),
    };

    // Store job data
    await this.redis.hset(`${this.JOB_DATA_PREFIX}:${jobId}`, 'data', JSON.stringify(job));

    // Add to pending queue
    await this.redis.lpush(this.PENDING_QUEUE, jobId);

    // Update stats
    await this.redis.hincrby(this.STATS_KEY, 'pending', 1);

    this.logger.debug('Job added to metrics queue', { jobId });
    return jobId;
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<QueueStats> {
    const stats = await this.redis.hgetall(this.STATS_KEY);

    const [pendingCount, processingCount, completedCount, failedCount] = await Promise.all([
      this.redis.llen(this.PENDING_QUEUE),
      this.redis.llen(this.PROCESSING_QUEUE),
      this.redis.llen(this.COMPLETED_QUEUE),
      this.redis.llen(this.FAILED_QUEUE),
    ]);

    return {
      pending: pendingCount,
      processing: processingCount,
      completed: completedCount,
      failed: failedCount,
      totalProcessed: parseInt(stats.totalProcessed || '0'),
      avgProcessingTime: parseFloat(stats.avgProcessingTime || '0'),
      lastProcessedAt: stats.lastProcessedAt ? parseInt(stats.lastProcessedAt) : undefined,
    };
  }

  /**
   * Process pending jobs
   */
  private async processJobs(): Promise<void> {
    if (!this.isProcessing) return;

    const currentJobs = this.activeJobs.size;
    if (currentJobs >= this.config.maxConcurrentJobs) {
      return; // Already at capacity
    }

    const slotsAvailable = this.config.maxConcurrentJobs - currentJobs;

    for (let i = 0; i < slotsAvailable; i++) {
      const jobId = await this.redis.rpoplpush(this.PENDING_QUEUE, this.PROCESSING_QUEUE);
      if (!jobId) break; // No more jobs

      // Process job asynchronously
      this.processJob(jobId).catch((error) => {
        this.logger.error('Unhandled error in job processing', { jobId, error });
      });
    }
  }

  /**
   * Process a single job
   */
  private async processJob(jobId: string): Promise<void> {
    this.activeJobs.add(jobId);
    const startTime = Date.now();

    try {
      // Get job data
      const jobDataRaw = await this.redis.hget(`${this.JOB_DATA_PREFIX}:${jobId}`, 'data');
      if (!jobDataRaw) {
        throw new Error('Job data not found');
      }

      const job: QueueJob = JSON.parse(jobDataRaw);
      job.attempts++;

      // Set timeout for job processing
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Job timeout')), this.config.jobTimeoutMs);
      });

      // Process the job with timeout
      await Promise.race([this.metricsCollector.processHttpLog(job.data), timeoutPromise]);

      // Job completed successfully
      await this.completeJob(jobId, job, Date.now() - startTime);
    } catch (error) {
      // Job failed
      await this.failJob(jobId, error as Error, Date.now() - startTime);
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Mark job as completed
   */
  private async completeJob(jobId: string, job: QueueJob, processingTime: number): Promise<void> {
    // Remove from processing queue
    await this.redis.lrem(this.PROCESSING_QUEUE, 0, jobId);

    // Add to completed queue
    await this.redis.lpush(this.COMPLETED_QUEUE, jobId);

    // Update job data
    job.scheduledAt = Date.now();
    await this.redis.hset(`${this.JOB_DATA_PREFIX}:${jobId}`, 'data', JSON.stringify(job));

    // Update stats
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(this.STATS_KEY, 'totalProcessed', 1);
    pipeline.hset(this.STATS_KEY, 'lastProcessedAt', Date.now().toString());

    // Update average processing time
    const stats = await this.redis.hgetall(this.STATS_KEY);
    const totalProcessed = parseInt(stats.totalProcessed || '0') + 1;
    const currentAvg = parseFloat(stats.avgProcessingTime || '0');
    const newAvg = (currentAvg * (totalProcessed - 1) + processingTime) / totalProcessed;
    pipeline.hset(this.STATS_KEY, 'avgProcessingTime', newAvg.toString());

    await pipeline.exec();

    this.logger.debug('Job completed', { jobId, processingTime, attempts: job.attempts });
  }

  /**
   * Mark job as failed and optionally retry
   */
  private async failJob(jobId: string, error: Error, _processingTime: number): Promise<void> {
    // Remove from processing queue
    await this.redis.lrem(this.PROCESSING_QUEUE, 0, jobId);

    // Get job data
    const jobDataRaw = await this.redis.hget(`${this.JOB_DATA_PREFIX}:${jobId}`, 'data');
    if (!jobDataRaw) {
      this.logger.error('Job data not found for failed job', { jobId });
      return;
    }

    const job: QueueJob = JSON.parse(jobDataRaw);
    job.lastError = error.message;

    if (job.attempts < job.maxAttempts) {
      // Retry the job
      job.scheduledAt = Date.now() + this.config.retryDelayMs * job.attempts; // Exponential backoff

      await this.redis.hset(`${this.JOB_DATA_PREFIX}:${jobId}`, 'data', JSON.stringify(job));

      // Schedule retry
      setTimeout(async () => {
        await this.redis.lpush(this.PENDING_QUEUE, jobId);
      }, this.config.retryDelayMs * job.attempts);

      this.logger.warn('Job failed, scheduling retry', {
        jobId,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        error: error.message,
        retryIn: this.config.retryDelayMs * job.attempts,
      });
    } else {
      // Job permanently failed
      await this.redis.lpush(this.FAILED_QUEUE, jobId);
      await this.redis.hset(`${this.JOB_DATA_PREFIX}:${jobId}`, 'data', JSON.stringify(job));

      this.logger.error('Job permanently failed', {
        jobId,
        attempts: job.attempts,
        error: error.message,
      });
    }
  }

  /**
   * Recover jobs that were stuck in processing when service went down
   */
  private async recoverStuckJobs(): Promise<void> {
    const processingJobs = await this.redis.lrange(this.PROCESSING_QUEUE, 0, -1);

    if (processingJobs.length > 0) {
      this.logger.info('Recovering stuck jobs', { count: processingJobs.length });

      // Move all processing jobs back to pending
      for (const jobId of processingJobs) {
        await this.redis.lrem(this.PROCESSING_QUEUE, 0, jobId);
        await this.redis.lpush(this.PENDING_QUEUE, jobId);
      }
    }
  }

  /**
   * Clean up old completed and failed jobs
   */
  private async cleanup(): Promise<void> {
    const now = Date.now();
    let cleanedCount = 0;

    // Clean completed jobs
    const completedJobs = await this.redis.lrange(this.COMPLETED_QUEUE, 0, -1);
    for (const jobId of completedJobs) {
      const jobDataRaw = await this.redis.hget(`${this.JOB_DATA_PREFIX}:${jobId}`, 'data');
      if (jobDataRaw) {
        const job: QueueJob = JSON.parse(jobDataRaw);
        if (now - job.scheduledAt > this.config.maxCompletedAge) {
          await this.redis.lrem(this.COMPLETED_QUEUE, 0, jobId);
          await this.redis.del(`${this.JOB_DATA_PREFIX}:${jobId}`);
          cleanedCount++;
        }
      }
    }

    // Clean failed jobs
    const failedJobs = await this.redis.lrange(this.FAILED_QUEUE, 0, -1);
    for (const jobId of failedJobs) {
      const jobDataRaw = await this.redis.hget(`${this.JOB_DATA_PREFIX}:${jobId}`, 'data');
      if (jobDataRaw) {
        const job: QueueJob = JSON.parse(jobDataRaw);
        if (now - job.scheduledAt > this.config.maxFailedAge) {
          await this.redis.lrem(this.FAILED_QUEUE, 0, jobId);
          await this.redis.del(`${this.JOB_DATA_PREFIX}:${jobId}`);
          cleanedCount++;
        }
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug('Cleaned up old jobs', { count: cleanedCount });
    }
  }

  /**
   * Clear all jobs (for testing/maintenance)
   */
  async clear(): Promise<void> {
    await Promise.all([
      this.redis.del(this.PENDING_QUEUE),
      this.redis.del(this.PROCESSING_QUEUE),
      this.redis.del(this.COMPLETED_QUEUE),
      this.redis.del(this.FAILED_QUEUE),
      this.redis.del(this.STATS_KEY),
    ]);

    // Clear job data
    const keys = await this.redis.keys(`${this.JOB_DATA_PREFIX}:*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }

    this.logger.info('Queue cleared');
  }
}
