/**
 * Redis-backed model store.
 * Stores fetched models per provider with no TTL — persists across restarts.
 * Key format: models:{providerId}
 */

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const KEY_PREFIX = 'models:';

let redis;

function getRedis() {
  if (!redis) {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });
    redis.on('error', (err) => console.error('[model-store] Redis error:', err.message));
    redis.connect().catch(() => {});
  }
  return redis;
}

/**
 * Store models for a provider. No TTL — persists until overwritten.
 */
export async function setModels(providerId, models, providerType) {
  try {
    const data = JSON.stringify({
      models,
      providerType,
      fetchedAt: new Date().toISOString(),
    });
    await getRedis().set(KEY_PREFIX + providerId, data);
  } catch (err) {
    console.error(`[model-store] Failed to save models for ${providerId}:`, err.message);
  }
}

/**
 * Get stored models for a provider.
 */
export async function getModels(providerId) {
  try {
    const raw = await getRedis().get(KEY_PREFIX + providerId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[model-store] Failed to read models for ${providerId}:`, err.message);
    return null;
  }
}

/**
 * Check if models are stored for a provider.
 */
export async function hasModels(providerId) {
  try {
    return (await getRedis().exists(KEY_PREFIX + providerId)) === 1;
  } catch {
    return false;
  }
}

/**
 * Delete stored models for a provider.
 */
export async function deleteModels(providerId) {
  try {
    await getRedis().del(KEY_PREFIX + providerId);
  } catch (err) {
    console.error(`[model-store] Failed to delete models for ${providerId}:`, err.message);
  }
}
