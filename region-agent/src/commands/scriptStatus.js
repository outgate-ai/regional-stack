/**
 * PROVIDER_SCRIPT_STATUS command handler.
 * Reports live script version and integrity from Kong.
 */

import { getService } from '../kong/service.js';
import { getPlugins } from '../kong/plugins.js';
import { getVersion, computeLiveChecksums } from '../versionMap.js';

export async function scriptStatus(command) {
  const { orgSlug, providerSlug, providerId } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;

  const service = await getService(name);
  const plugins = await getPlugins(service.id);
  const preFunction = plugins?.data?.find(p => p.name === 'pre-function');

  if (!preFunction) {
    return {
      providerId,
      version: null,
      checksums: null,
      integrity: 'no_plugin',
      deployedAt: null,
    };
  }

  // Compute live checksums from Kong
  const liveChecksums = computeLiveChecksums(preFunction.config);

  // Get stored version from in-memory map
  const stored = getVersion(providerId);

  // Parse version from tags
  let tagVersion = null;
  let tagChecksums = {};
  if (preFunction.tags) {
    for (const tag of preFunction.tags) {
      if (tag.startsWith('gw:version=')) tagVersion = parseInt(tag.split('=')[1], 10);
      else if (tag.startsWith('gw:cs:access=')) tagChecksums.access = tag.split('=')[1];
      else if (tag.startsWith('gw:cs:body_filter=')) tagChecksums.body_filter = tag.split('=')[1];
      else if (tag.startsWith('gw:cs:header_filter=')) tagChecksums.header_filter = tag.split('=')[1];
    }
  }

  // Compare live checksums against stored/tag checksums
  const expectedChecksums = tagChecksums.access ? tagChecksums : stored?.checksums;
  let integrity = 'unknown';
  if (expectedChecksums) {
    integrity = liveChecksums.access === expectedChecksums.access
      && liveChecksums.body_filter === expectedChecksums.body_filter
      && liveChecksums.header_filter === expectedChecksums.header_filter
      ? 'ok' : 'mismatch';
  }

  return {
    providerId,
    version: tagVersion || stored?.version || null,
    checksums: liveChecksums,
    integrity,
    deployedAt: stored?.deployedAt || null,
  };
}
