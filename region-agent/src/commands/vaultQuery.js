/**
 * VAULT_STATS / VAULT_LIST / VAULT_DELETE command handlers.
 * Proxies requests to the guardrail service's /vault/* endpoints.
 */

import { getConfig } from '../config.js';

async function queryGuardrailVault(path, method = 'GET') {
  const config = getConfig();
  const url = `${config.guardrailUrl}${path}`;

  console.log(`[vault-query] ${method} ${url}`);

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-key': config.guardrailApiKey || '',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Guardrail vault returned ${response.status}: ${body}`);
  }

  return response.json();
}

export async function vaultStats(command) {
  const orgId = command.organizationId;
  const data = await queryGuardrailVault(`/vault/stats?organizationId=${encodeURIComponent(orgId)}`);
  return { ...data, providerId: 'system' };
}

export async function vaultList(command) {
  const orgId = command.organizationId;
  const { page = 1, limit = 50, category } = command.payload || {};

  const params = new URLSearchParams({ organizationId: orgId, page: String(page), limit: String(limit) });
  if (category) params.set('category', category);

  const data = await queryGuardrailVault(`/vault/detections?${params}`);
  return { ...data, providerId: 'system' };
}

export async function vaultDelete(command) {
  const orgId = command.organizationId;
  const { hash } = command.payload || {};
  if (!hash) throw new Error('VAULT_DELETE requires payload.hash');

  const data = await queryGuardrailVault(
    `/vault/detections/${encodeURIComponent(hash)}?organizationId=${encodeURIComponent(orgId)}`,
    'DELETE',
  );
  return { ...data, providerId: 'system' };
}
