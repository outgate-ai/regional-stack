import { Router } from 'express';
import Redis from 'ioredis';
import { Logger } from 'pino';

export function statsRouter(redis: Redis, _logger: Logger): Router {
  const router = Router();

  /**
   * @swagger
   * /stats:
   *   get:
   *     summary: Get log statistics
   *     responses:
   *       200:
   *         description: Log statistics
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 rates:
   *                   type: object
   *                   properties:
   *                     m1:
   *                       type: number
   *                     m5:
   *                       type: number
   *                     m60:
   *                       type: number
   *                 topUsers:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       userId:
   *                         type: string
   *                       count:
   *                         type: number
   *                 levelBreakdown:
   *                   type: object
   */
  router.get('/', async (req, res, next) => {
    try {
      const now = Date.now();

      const m1Count = await redis.zcount('logs:rate:1m', now - 60000, now);
      const m5Count = await redis.zcount('logs:rate:5m', now - 300000, now);
      const m60Count = await redis.zcount('logs:rate:60m', now - 3600000, now);

      const userKeys = await redis.keys('logs:user:*');
      const topUsers = [];

      for (const key of userKeys.slice(0, 10)) {
        const count = await redis.get(key);
        const userId = key.replace('logs:user:', '');
        if (count) {
          topUsers.push({ userId, count: parseInt(count, 10) });
        }
      }

      topUsers.sort((a, b) => b.count - a.count);

      const levels = ['info', 'warn', 'error', 'debug'];
      const levelBreakdown: Record<string, number> = {};

      for (const level of levels) {
        const count = await redis.get(`logs:count:${level}`);
        levelBreakdown[level] = parseInt(count || '0', 10);
      }

      res.json({
        rates: {
          m1: m1Count,
          m5: m5Count,
          m60: m60Count,
        },
        topUsers: topUsers.slice(0, 5),
        levelBreakdown,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
