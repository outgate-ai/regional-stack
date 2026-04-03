/**
 * Fingerprint Store — KV cache for detected PII/credentials.
 *
 * Stores SHA256 hashes of detected values in Redis so future requests
 * can be matched without calling the LLM again.
 *
 * Matching uses a first-token indexed sequential walk:
 *   1. Tokenize input on expanded delimiters (whitespace, . : @ / - _ , ; =)
 *   2. Check each token against first-token index (single SISMEMBER pipeline)
 *   3. On hit, sequential walk to verify full token sequence
 *   4. Extract original span from raw text (with delimiters intact)
 *
 * Storage modes (FINGERPRINT_STORAGE_MODE env var):
 *   - (unset/empty): hash-only, no plaintext — production default
 *   - "debug":       stores full plaintext value alongside hash — dev only
 */

import { createHash } from 'crypto';
import Redis from 'ioredis';
import { Detection } from '../types/riskConfig';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface FingerprintEntry {
  type: string;          // detection category
  tokens: string[];      // delimiter-split tokens (lowercase)
  tokenCount: number;    // tokens.length (for quick filtering)
  value?: string;        // plaintext — only in debug mode
  createdAt: string;
  lastSeenAt: string;
}

export interface ScanMatch {
  hash: string;
  type: string;
  originalText: string;  // extracted from raw input, delimiters intact
  tokenCount: number;
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

/* ------------------------------------------------------------------ */
/*  Constants & state                                                  */
/* ------------------------------------------------------------------ */

const FINGERPRINT_TTL = parseInt(process.env.FINGERPRINT_TTL_SECONDS || '604800'); // 7 days
const STORAGE_MODE = (process.env.FINGERPRINT_STORAGE_MODE || '').toLowerCase() === 'debug' ? 'debug' : 'strict';

// Expanded delimiter regex — splits on whitespace + common separators
const DELIMITER_REGEX = /[\s.:@\/\-_,;=]+/;
// Regex to find non-delimiter runs in raw text (for span extraction)
const TOKEN_RUN_REGEX = /[^\s.:@\/\-_,;=]+/g;

let redis: Redis | null = null;

/* ------------------------------------------------------------------ */
/*  Init                                                               */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Tokenization & hashing                                             */
/* ------------------------------------------------------------------ */

/** Split text on expanded delimiters → lowercase token array */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(DELIMITER_REGEX).filter(t => t.length > 0);
}

/** Normalize for hashing: lowercase, trim, collapse whitespace */
export function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** SHA256 of normalized text */
export function hashValue(text: string): string {
  return createHash('sha256').update(normalize(text)).digest('hex');
}

/* ------------------------------------------------------------------ */
/*  Store detections                                                   */
/* ------------------------------------------------------------------ */

/**
 * Store detections from an LLM evaluation into the fingerprint KV store.
 * Builds the first-token index for fast matching.
 * Fire-and-forget — never blocks the request path.
 */
export async function storeDetections(
  orgId: string,
  detections: Detection[],
  anonymizationMap?: Array<[string, string]>,
): Promise<number> {
  if (!redis || detections.length === 0) return 0;

  const pipeline = redis.pipeline();
  let stored = 0;
  const now = new Date().toISOString();

  for (const det of detections) {
    const hash = hashValue(det.text);
    const tokens = tokenize(det.text);
    if (tokens.length === 0) continue;
    const firstToken = tokens[0];

    // Check if entry already exists → update lastSeenAt only
    const existing = await redis.hget(`fp:${orgId}`, hash);
    if (existing) {
      try {
        const parsed = JSON.parse(existing);
        parsed.lastSeenAt = now;
        pipeline.hset(`fp:${orgId}`, hash, JSON.stringify(parsed));
      } catch { /* skip */ }
      continue;
    }

    // New detection — store full entry
    const entry: FingerprintEntry = {
      type: det.category,
      tokens,
      tokenCount: tokens.length,
      createdAt: now,
      lastSeenAt: now,
    };

    if (STORAGE_MODE === 'debug') {
      entry.value = det.text;
    }

    pipeline.hset(`fp:${orgId}`, hash, JSON.stringify(entry));

    // Index by first token
    pipeline.sadd(`fp_first:${orgId}`, firstToken);

    // Append hash to first-token → hashes mapping
    const existingHashes = await redis.hget(`fp_by_first:${orgId}`, firstToken);
    const hashList: string[] = existingHashes ? JSON.parse(existingHashes) : [];
    if (!hashList.includes(hash)) {
      hashList.push(hash);
      pipeline.hset(`fp_by_first:${orgId}`, firstToken, JSON.stringify(hashList));
    }

    stored++;
  }

  // Set TTLs
  pipeline.expire(`fp:${orgId}`, FINGERPRINT_TTL);
  pipeline.expire(`fp_first:${orgId}`, FINGERPRINT_TTL);
  pipeline.expire(`fp_by_first:${orgId}`, FINGERPRINT_TTL);

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

/* ------------------------------------------------------------------ */
/*  Scan for detections (KV matching — replaces LLM for known items)   */
/* ------------------------------------------------------------------ */

/**
 * Scan raw text for known fingerprints using first-token indexed sequential walk.
 * Returns matches with original text spans (delimiters intact) for anonymization.
 */
export async function scanForDetections(orgId: string, rawText: string): Promise<ScanMatch[]> {
  if (!redis) return [];

  // 1. Tokenize input
  const inputTokens = tokenize(rawText);
  if (inputTokens.length === 0) return [];

  // 2. Pipeline: check which input tokens are first-tokens of any detection
  const pipeline = redis.pipeline();
  for (const token of inputTokens) {
    pipeline.sismember(`fp_first:${orgId}`, token);
  }
  const firstTokenResults = await pipeline.exec();
  if (!firstTokenResults) return [];

  // 3. For each hit, get candidates and verify sequential match
  const matches: ScanMatch[] = [];
  const matchedRanges: Array<[number, number]> = []; // track to avoid overlaps

  for (let i = 0; i < inputTokens.length; i++) {
    // Skip if already part of a previous match
    if (matchedRanges.some(([s, e]) => i >= s && i < e)) continue;

    const isFirstToken = firstTokenResults[i]?.[1];
    if (!isFirstToken) continue;

    // Get all detection hashes starting with this token
    const candidatesJson = await redis.hget(`fp_by_first:${orgId}`, inputTokens[i]);
    if (!candidatesJson) continue;
    const candidateHashes: string[] = JSON.parse(candidatesJson);

    // Sort candidates by tokenCount descending (longest match first)
    const candidates: Array<{ hash: string; entry: FingerprintEntry }> = [];
    for (const hash of candidateHashes) {
      const entryJson = await redis.hget(`fp:${orgId}`, hash);
      if (!entryJson) continue;
      candidates.push({ hash, entry: JSON.parse(entryJson) });
    }
    candidates.sort((a, b) => b.entry.tokenCount - a.entry.tokenCount);

    for (const { hash, entry } of candidates) {
      // Bounds check
      if (i + entry.tokenCount > inputTokens.length) continue;

      // Sequential walk: verify all tokens match in order
      let allMatch = true;
      for (let j = 0; j < entry.tokenCount; j++) {
        if (inputTokens[i + j] !== entry.tokens[j]) {
          allMatch = false;
          break;
        }
      }

      if (allMatch) {
        // Extract original span from raw text (preserving delimiters)
        const originalText = extractOriginalSpan(rawText, i, entry.tokenCount);
        if (originalText) {
          matches.push({
            hash,
            type: entry.type,
            originalText,
            tokenCount: entry.tokenCount,
          });
          matchedRanges.push([i, i + entry.tokenCount]);

          // Update lastSeenAt (fire-and-forget)
          entry.lastSeenAt = new Date().toISOString();
          redis.hset(`fp:${orgId}`, hash, JSON.stringify(entry)).catch(() => {});
        }
        break; // longest match wins, move on
      }
    }
  }

  return matches;
}

/**
 * Given that tokens starting at tokenStartIdx matched, find the corresponding
 * substring in the original raw text (preserving all delimiters).
 */
function extractOriginalSpan(rawText: string, tokenStartIdx: number, tokenCount: number): string | null {
  let tokenIdx = 0;
  let spanStart = -1;
  let spanEnd = -1;

  // Find all non-delimiter runs in the raw text
  const regex = new RegExp(TOKEN_RUN_REGEX.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(rawText)) !== null) {
    if (tokenIdx === tokenStartIdx) {
      spanStart = match.index;
    }
    if (tokenIdx === tokenStartIdx + tokenCount - 1) {
      spanEnd = match.index + match[0].length;
      break;
    }
    tokenIdx++;
  }

  if (spanStart >= 0 && spanEnd > spanStart) {
    return rawText.substring(spanStart, spanEnd);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Metrics                                                            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Vault API (stats, list, delete)                                    */
/* ------------------------------------------------------------------ */

export async function getVaultStats(orgId: string): Promise<VaultStats> {
  if (!redis) return emptyStats();

  const now = Date.now();
  const dayAgo = now - 86400000;

  const [fpLen, metrics, hits24h, misses24h, newToday] = await Promise.all([
    redis.hlen(`fp:${orgId}`),
    redis.hgetall(`vault_metrics:${orgId}`),
    redis.zcount(`vault_hits:${orgId}`, dayAgo, '+inf'),
    redis.zcount(`vault_misses:${orgId}`, dayAgo, '+inf'),
    redis.zcount(`vault_new:${orgId}`, dayAgo, '+inf'),
  ]);

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

  all.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());

  const start = (page - 1) * limit;
  const detections = all.slice(start, start + limit);

  return { detections, total: all.length, page, storageMode: STORAGE_MODE };
}

export async function deleteDetection(orgId: string, hash: string): Promise<boolean> {
  if (!redis) return false;

  // Get the entry to find its first token (for index cleanup)
  const entryJson = await redis.hget(`fp:${orgId}`, hash);
  if (!entryJson) return false;

  const entry: FingerprintEntry = JSON.parse(entryJson);
  const firstToken = entry.tokens?.[0];

  // Delete from main store
  await redis.hdel(`fp:${orgId}`, hash);

  // Clean up first-token index
  if (firstToken) {
    const hashListJson = await redis.hget(`fp_by_first:${orgId}`, firstToken);
    if (hashListJson) {
      const hashList: string[] = JSON.parse(hashListJson);
      const updated = hashList.filter(h => h !== hash);
      if (updated.length === 0) {
        await redis.hdel(`fp_by_first:${orgId}`, firstToken);
        await redis.srem(`fp_first:${orgId}`, firstToken);
      } else {
        await redis.hset(`fp_by_first:${orgId}`, firstToken, JSON.stringify(updated));
      }
    }
  }

  return true;
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

export function getRedis(): Redis | null {
  return redis;
}
