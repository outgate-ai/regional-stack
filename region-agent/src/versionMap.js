/**
 * In-memory version map for tracking deployed script versions per provider.
 * Rebuilt from Kong plugin tags on agent startup.
 */

import { createHash } from 'node:crypto';
import * as kong from './kong/client.js';

// Map<providerId, { version, checksums: { access, body_filter, header_filter }, deployedAt }>
const versions = new Map();

export function getVersion(providerId) {
  return versions.get(providerId) || null;
}

export function setVersion(providerId, data) {
  versions.set(providerId, data);
}

export function deleteVersion(providerId) {
  versions.delete(providerId);
}

/**
 * Compute SHA-256 checksum of concatenated scripts.
 */
export function computeChecksum(scripts) {
  if (!scripts || scripts.length === 0) return createHash('sha256').update('').digest('hex');
  return createHash('sha256').update(scripts.join('\n')).digest('hex');
}

/**
 * Compute live checksums from a pre-function plugin config.
 */
export function computeLiveChecksums(pluginConfig) {
  return {
    access: computeChecksum(pluginConfig?.access || []),
    body_filter: computeChecksum(pluginConfig?.body_filter || []),
    header_filter: computeChecksum(pluginConfig?.header_filter || []),
  };
}

/**
 * Parse version metadata from Kong plugin tags.
 * Tags format: gw:version=N, gw:cs:access=hash, gw:cs:body_filter=hash, gw:cs:header_filter=hash
 */
function parseTagsMetadata(tags) {
  if (!tags || !Array.isArray(tags)) return null;

  const meta = { version: null, checksums: {} };
  for (const tag of tags) {
    if (tag.startsWith('gw:version=')) {
      meta.version = parseInt(tag.split('=')[1], 10);
    } else if (tag.startsWith('gw:cs:access=')) {
      meta.checksums.access = tag.split('=')[1];
    } else if (tag.startsWith('gw:cs:body_filter=')) {
      meta.checksums.body_filter = tag.split('=')[1];
    } else if (tag.startsWith('gw:cs:header_filter=')) {
      meta.checksums.header_filter = tag.split('=')[1];
    }
  }

  return meta.version ? meta : null;
}

/**
 * Rebuild version map from Kong on startup.
 * Scans all services and their pre-function plugins for gw:* tags.
 */
export async function rebuildFromKong() {
  try {
    const servicesRes = await kong.get('/services');
    const services = servicesRes?.data || [];

    for (const service of services) {
      // Extract providerId from service name (format: orgSlug-providerSlug)
      const parts = service.name?.split('-');
      if (!parts || parts.length < 2) continue;
      const providerId = parts.slice(1).join('-');

      const pluginsRes = await kong.get(`/services/${service.id}/plugins`);
      const plugins = pluginsRes?.data || [];
      const preFunction = plugins.find(p => p.name === 'pre-function');

      if (preFunction?.tags) {
        const meta = parseTagsMetadata(preFunction.tags);
        if (meta) {
          versions.set(providerId, {
            version: meta.version,
            checksums: meta.checksums,
            deployedAt: null, // unknown from tags alone
          });
        }
      }
    }

    console.log(`[version-map] Rebuilt from Kong: ${versions.size} providers tracked`);
  } catch (err) {
    console.error(`[version-map] Failed to rebuild from Kong:`, err.message);
  }
}
