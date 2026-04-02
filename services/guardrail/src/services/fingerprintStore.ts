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
  token: string;       // anonymization replacement e.g. "[CRED_1]"
  type: string;        // detection category
  words: number;       // word count for n-gram optimization
  score: number;       // confidence from LLM
  source: 'llm' | 'cli';
  value?: string;      // plaintext — only in debug mode
  createdAt: string;
}

export interface VaultStats {
  totalFingerprints: number;
  storageMode: 'strict' | 'debug';
  storageBytes: number;
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
  source: 'llm' | 'cli' = 'llm',
): Promise<number> {
  if (!redis || detections.length === 0) return 0;

  // Build a lookup from original text → anonymization token
  const tokenMap = new Map<string, string>();
  if (anonymizationMap) {
    for (const [original, token] of anonymizationMap) {
      tokenMap.set(normalize(original), token);
    }
  }

  const pipeline = redis.pipeline();
  let maxWords = 1;
  let stored = 0;

  for (const det of detections) {
    const hash = hashValue(det.text);
    const wordCount = det.text.split(/\s+/).length;
    const anonToken = tokenMap.get(normalize(det.text)) || `[${det.category.toUpperCase()}_${hash.slice(0, 6)}]`;

    const entry: FingerprintEntry = {
      token: anonToken,
      type: det.category,
      words: wordCount,
      score: 0.9,
      source,
      createdAt: new Date().toISOString(),
    };

    if (STORAGE_MODE === 'debug') {
      entry.value = det.text;
    }

    pipeline.hset(`fp:${orgId}`, hash, JSON.stringify(entry));
    stored++;

    if (wordCount > maxWords) maxWords = wordCount;
  }

  if (maxWords > 1) {
    // Only update if higher than current
    const current = await redis.get(`fp:${orgId}:maxWords`);
    if (!current || parseInt(current) < maxWords) {
      pipeline.set(`fp:${orgId}:maxWords`, maxWords.toString());
      pipeline.expire(`fp:${orgId}:maxWords`, FINGERPRINT_TTL);
    }
  }

  pipeline.expire(`fp:${orgId}`, FINGERPRINT_TTL);

  // Update metrics
  pipeline.hincrby(`vault_metrics:${orgId}`, 'total_stored', stored);
  pipeline.hset(`vault_metrics:${orgId}`, 'last_store_at', new Date().toISOString());

  // Track new-today count (sorted set with 24h TTL)
  const now = Date.now();
  pipeline.zadd(`vault_new:${orgId}`, now.toString(), `${now}-${stored}`);
  pipeline.expire(`vault_new:${orgId}`, 86400);

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

  const [fpLen, metrics, hits24h, misses24h, newToday, memInfo] = await Promise.all([
    redis.hlen(`fp:${orgId}`),
    redis.hgetall(`vault_metrics:${orgId}`),
    redis.zcount(`vault_hits:${orgId}`, dayAgo, '+inf'),
    redis.zcount(`vault_misses:${orgId}`, dayAgo, '+inf'),
    redis.zcount(`vault_new:${orgId}`, dayAgo, '+inf'),
    redis.memory('USAGE', `fp:${orgId}`).catch(() => 0),
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
    storageBytes: (memInfo as number) || 0,
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
  source?: string,
): Promise<VaultListResult> {
  if (!redis) {
    return { detections: [], total: 0, page, storageMode: STORAGE_MODE };
  }

  // Scan all entries (Redis HSCAN doesn't support offset natively)
  const all: Array<FingerprintEntry & { hash: string }> = [];
  let cursor = '0';
  do {
    const [nextCursor, fields] = await redis.hscan(`fp:${orgId}`, cursor, 'COUNT', 500);
    cursor = nextCursor;
    for (let i = 0; i < fields.length; i += 2) {
      try {
        const entry: FingerprintEntry = JSON.parse(fields[i + 1]);
        if (category && entry.type !== category) continue;
        if (source && entry.source !== source) continue;
        all.push({ ...entry, hash: fields[i] });
      } catch { /* skip */ }
    }
  } while (cursor !== '0');

  // Sort by createdAt descending
  all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

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
    storageBytes: 0,
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
