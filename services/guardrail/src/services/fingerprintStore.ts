/**
 * Fingerprint Store — KV cache for detected PII/credentials.
 *
 * Stores SHA256 hashes of detected values in Redis so future requests
 * can be matched without calling the LLM again.
 *
 * Storage modes (FINGERPRINT_STORAGE_MODE env var):
 *   - (unset/empty): hash-only, no plaintext — production default
 *   - "debug":       stores full plaintext value alongside hash — dev only
 */

import { createHash } from 'crypto';
import Redis from 'ioredis';
import { Detection } from '../types/riskConfig';

export interface FingerprintEntry {
  type: string;        // detection category (credential, personal_information, etc.)
  tokenCount: number;  // number of whitespace-delimited tokens that produce this hash
  value?: string;      // plaintext — only in debug mode
  createdAt: string;
  lastSeenAt: string;
}

export interface VaultStats {
  totalFingerprints: number;
  storageMode: 'strict' | 'debug';
  totalLookups: number;
  totalHits: number;
  totalMisses: number;
  totalStored: number;
  hitRate24h: number;
  newToday: number;
  byCategory: Record<string, number>;
  lastScanAt: string | null;
  lastStoreAt: string | null;
}

export interface VaultListResult {
  detections: Array<FingerprintEntry & { hash: string }>;
  total: number;
  page: number;
  storageMode: 'strict' | 'debug';
}

const FINGERPRINT_TTL = parseInt(process.env.FINGERPRINT_TTL_SECONDS || '604800'); // 7 days
const STORAGE_MODE = (process.env.FINGERPRINT_STORAGE_MODE || '').toLowerCase() === 'debug' ? 'debug' : 'strict';

let redis: Redis | null = null;

export function initFingerprintStore(redisUrl: string): void {
  redis = new Redis(redisUrl, {
    retryStrategy: (times) => Math.min(times * 50, 2000),
    lazyConnect: true,
  });

  redis.connect().catch((err) => {
    console.error('[fingerprint-store] Redis connection failed:', err.message);
  });

  if (STORAGE_MODE === 'debug') {
    console.warn('');
    console.warn('⚠️  WARNING: FINGERPRINT_STORAGE_MODE=debug is enabled.');
    console.warn('⚠️  Detection values are stored in PLAINTEXT in Redis.');
    console.warn('⚠️  DO NOT use this mode in production.');
    console.warn('');
  }
}

export function getStorageMode(): 'strict' | 'debug' {
  return STORAGE_MODE;
}

export function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function hashValue(text: string): string {
  return createHash('sha256').update(normalize(text)).digest('hex');
}

/**
 * Store detections from an LLM evaluation into the fingerprint KV store.
 * Fire-and-forget — never blocks the request path.
 */
export async function storeDetections(
  orgId: string,
  detections: Detection[],
  anonymizationMap?: Array<[string, string]>,
): Promise<number> {
  if (!redis || detections.length === 0) return 0;

  const pipeline = redis.pipeline();
  let maxWords = 1;
  let stored = 0;
  const now = new Date().toISOString();

  for (const det of detections) {
    const hash = hashValue(det.text);
    const tokenCount = det.text.split(/\s+/).length;

    // Check if entry already exists (update lastSeenAt if so)
    const existing = await redis.hget(`fp:${orgId}`, hash);
    if (existing) {
      try {
        const parsed = JSON.parse(existing);
        parsed.lastSeenAt = now;
        pipeline.hset(`fp:${orgId}`, hash, JSON.stringify(parsed));
      } catch { /* skip */ }
      continue;
    }

    const entry: FingerprintEntry = {
      type: det.category,
      tokenCount,
      createdAt: now,
      lastSeenAt: now,
    };

    if (STORAGE_MODE === 'debug') {
      entry.value = det.text;
    }

    pipeline.hset(`fp:${orgId}`, hash, JSON.stringify(entry));
    stored++;

    if (tokenCount > maxWords) maxWords = tokenCount;
  }

  if (maxWords > 1) {
    const current = await redis.get(`fp:${orgId}:maxWords`);
    if (!current || parseInt(current) < maxWords) {
      pipeline.set(`fp:${orgId}:maxWords`, maxWords.toString());
      pipeline.expire(`fp:${orgId}:maxWords`, FINGERPRINT_TTL);
    }
  }

  pipeline.expire(`fp:${orgId}`, FINGERPRINT_TTL);

  // Update metrics
  if (stored > 0) {
    pipeline.hincrby(`vault_metrics:${orgId}`, 'total_stored', stored);
    pipeline.hset(`vault_metrics:${orgId}`, 'last_store_at', now);

    const nowMs = Date.now();
    pipeline.zadd(`vault_new:${orgId}`, nowMs.toString(), `${nowMs}-${stored}`);
    pipeline.expire(`vault_new:${orgId}`, 86400);
  }

  await pipeline.exec();
  return stored;
}

/**
 * Record metrics for a fingerprint scan (called on every guardrail evaluation).
 */
export async function recordScanMetrics(orgId: string, hits: number, newDetections: number): Promise<void> {
  if (!redis) return;

  const now = Date.now();
  const pipeline = redis.pipeline();

  pipeline.hincrby(`vault_metrics:${orgId}`, 'total_lookups', 1);
  pipeline.hset(`vault_metrics:${orgId}`, 'last_scan_at', new Date().toISOString());

  if (hits > 0) {
    pipeline.hincrby(`vault_metrics:${orgId}`, 'total_hits', hits);
    pipeline.zadd(`vault_hits:${orgId}`, now.toString(), `${now}`);
    pipeline.expire(`vault_hits:${orgId}`, 86400);
  }

  if (newDetections > 0) {
    pipeline.hincrby(`vault_metrics:${orgId}`, 'total_misses', newDetections);
    pipeline.zadd(`vault_misses:${orgId}`, now.toString(), `${now}`);
    pipeline.expire(`vault_misses:${orgId}`, 86400);
  }

  await pipeline.exec();
}

/**
 * Get vault statistics for an organization.
 */
export async function getVaultStats(orgId: string): Promise<VaultStats> {
  if (!redis) {
    return emptyStats();
  }

  const now = Date.now();
  const dayAgo = now - 86400000;

  const [fpLen, metrics, hits24h, misses24h, newToday] = await Promise.all([
    redis.hlen(`fp:${orgId}`),
    redis.hgetall(`vault_metrics:${orgId}`),
    redis.zcount(`vault_hits:${orgId}`, dayAgo, '+inf'),
    redis.zcount(`vault_misses:${orgId}`, dayAgo, '+inf'),
    redis.zcount(`vault_new:${orgId}`, dayAgo, '+inf'),
  ]);

  // Count by category
  const byCategory: Record<string, number> = {};
  if (fpLen > 0) {
    let cursor = '0';
    do {
      const [nextCursor, fields] = await redis.hscan(`fp:${orgId}`, cursor, 'COUNT', 500);
      cursor = nextCursor;
      for (let i = 1; i < fields.length; i += 2) {
        try {
          const entry: FingerprintEntry = JSON.parse(fields[i]);
          byCategory[entry.type] = (byCategory[entry.type] || 0) + 1;
        } catch { /* skip */ }
      }
    } while (cursor !== '0');
  }

  const total24h = hits24h + misses24h;

  return {
    totalFingerprints: fpLen,
    storageMode: STORAGE_MODE,
    totalLookups: parseInt(metrics?.total_lookups || '0'),
    totalHits: parseInt(metrics?.total_hits || '0'),
    totalMisses: parseInt(metrics?.total_misses || '0'),
    totalStored: parseInt(metrics?.total_stored || '0'),
    hitRate24h: total24h > 0 ? hits24h / total24h : 0,
    newToday,
    byCategory,
    lastScanAt: metrics?.last_scan_at || null,
    lastStoreAt: metrics?.last_store_at || null,
  };
}

/**
 * List fingerprint detections with pagination.
 */
export async function listDetections(
  orgId: string,
  page: number = 1,
  limit: number = 50,
  category?: string,
): Promise<VaultListResult> {
  if (!redis) {
    return { detections: [], total: 0, page, storageMode: STORAGE_MODE };
  }

  const all: Array<FingerprintEntry & { hash: string }> = [];
  let cursor = '0';
  do {
    const [nextCursor, fields] = await redis.hscan(`fp:${orgId}`, cursor, 'COUNT', 500);
    cursor = nextCursor;
    for (let i = 0; i < fields.length; i += 2) {
      try {
        const entry: FingerprintEntry = JSON.parse(fields[i + 1]);
        if (category && entry.type !== category) continue;
        all.push({ ...entry, hash: fields[i] });
      } catch { /* skip */ }
    }
  } while (cursor !== '0');

  // Sort by lastSeenAt descending
  all.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());

  const start = (page - 1) * limit;
  const detections = all.slice(start, start + limit);

  return { detections, total: all.length, page, storageMode: STORAGE_MODE };
}

/**
 * Delete a single fingerprint by hash.
 */
export async function deleteDetection(orgId: string, hash: string): Promise<boolean> {
  if (!redis) return false;
  const deleted = await redis.hdel(`fp:${orgId}`, hash);
  return deleted > 0;
}

function emptyStats(): VaultStats {
  return {
    totalFingerprints: 0,
    storageMode: STORAGE_MODE,
    totalLookups: 0,
    totalHits: 0,
    totalMisses: 0,
    totalStored: 0,
    hitRate24h: 0,
    newToday: 0,
    byCategory: {},
    lastScanAt: null,
    lastStoreAt: null,
  };
}

/** Get the Redis instance (for region-agent vault commands) */
export function getRedis(): Redis | null {
  return redis;
}
