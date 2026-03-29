import { getConfig } from '../config.js';

export async function toolQuery(command) {
  const { action, providerId, organizationId, toolHash, sort } = command.payload;
  const config = getConfig();
  const baseUrl = `${config.logManagerUrl}/logs/tools`;

  let url;
  let method = 'GET';

  switch (action) {
    case 'list':
      url = `${baseUrl}/${organizationId}/${providerId}${sort ? `?sort=${sort}` : ''}`;
      break;
    case 'get':
      url = `${baseUrl}/${organizationId}/${providerId}/${toolHash}`;
      break;
    case 'delete':
      url = `${baseUrl}/${organizationId}/${providerId}/${toolHash}`;
      method = 'DELETE';
      break;
    case 'clear':
      url = `${baseUrl}/${organizationId}/${providerId}`;
      method = 'DELETE';
      break;
    default:
      throw new Error(`Unknown tool query action: ${action}`);
  }

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-key': config.guardrailApiKey || '',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tool query failed (${res.status}): ${body}`);
  }

  return await res.json();
}
