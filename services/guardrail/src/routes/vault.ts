/**
 * Detection Vault API routes.
 * Exposes fingerprint store stats, listing, and deletion.
 * Called by the region-agent via VAULT_* commands.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { getVaultStats, listDetections, deleteDetection } from '../services/fingerprintStore';

export function vaultRoutes(logger: Logger): Router {
  const router = Router();
  router.use(authMiddleware);

  // GET /vault/stats?organizationId=...
  router.get(
    '/stats',
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const orgId = (req.query.organizationId as string) || '';
      if (!orgId) return res.status(400).json({ error: 'organizationId required' });

      const stats = await getVaultStats(orgId);
      logger.debug({ orgId, total: stats.totalFingerprints }, 'Vault stats queried');
      res.json(stats);
    }),
  );

  // GET /vault/detections?organizationId=...&page=1&limit=50&category=&source=
  router.get(
    '/detections',
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const orgId = (req.query.organizationId as string) || '';
      if (!orgId) return res.status(400).json({ error: 'organizationId required' });

      const page = parseInt((req.query.page as string) || '1');
      const limit = Math.min(parseInt((req.query.limit as string) || '50'), 200);
      const category = (req.query.category as string) || undefined;

      const result = await listDetections(orgId, page, limit, category);
      res.json(result);
    }),
  );

  // DELETE /vault/detections/:hash?organizationId=...
  router.delete(
    '/detections/:hash',
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const orgId = (req.query.organizationId as string) || '';
      if (!orgId) return res.status(400).json({ error: 'organizationId required' });

      const deleted = await deleteDetection(orgId, req.params.hash);
      if (!deleted) return res.status(404).json({ error: 'Fingerprint not found' });

      logger.info({ orgId, hash: req.params.hash }, 'Fingerprint deleted');
      res.json({ deleted: true });
    }),
  );

  return router;
}
