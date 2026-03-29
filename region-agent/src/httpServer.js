import http from 'node:http';
import crypto from 'node:crypto';
import { routeCommand } from './commandRouter.js';
import { hasModels } from './commands/modelStore.js';
import { createService, getService } from './kong/service.js';
import { createRoute, getRoutesByService } from './kong/route.js';
import { addPlugin, getPlugins } from './kong/plugins.js';
import * as kong from './kong/client.js';

let _server = null;

async function registerKongRoute(config) {
  const KONG_COMMANDS_SERVICE = config.kongCommandsServiceName;
  const KONG_HEALTH_SERVICE = config.kongHealthServiceName;
  const BFF_CONSUMER_NAME = config.kongBffConsumerName;

  try {
    let cmdService;
    try {
      cmdService = await getService(KONG_COMMANDS_SERVICE);
    } catch {
      cmdService = await createService(KONG_COMMANDS_SERVICE, {
        host: 'region-agent',
        port: config.httpPort,
        protocol: 'http',
        path: '/',
      });
    }

    const { data: cmdRoutes } = await getRoutesByService(KONG_COMMANDS_SERVICE);
    if (!cmdRoutes?.length) {
      await createRoute(KONG_COMMANDS_SERVICE, {
        paths: ['/api/commands'],
        strip_path: false,
        preserve_host: false,
      });
    }

    const { data: cmdPlugins } = await getPlugins(cmdService.id);
    if (!cmdPlugins?.some(p => p.name === 'key-auth')) {
      await addPlugin(cmdService.id, 'key-auth', {
        key_names: ['x-commands-key'],
        hide_credentials: true,
      });
    }

    if (!cmdPlugins?.some(p => p.name === 'rate-limiting')) {
      await addPlugin(cmdService.id, 'rate-limiting', {
        minute: config.kongCommandsRateLimitMinute,
        policy: 'local',
      });
    }

    await ensureBffConsumer(config, BFF_CONSUMER_NAME);

    try {
      await getService(KONG_HEALTH_SERVICE);
    } catch {
      await createService(KONG_HEALTH_SERVICE, {
        host: 'region-agent',
        port: config.httpPort,
        protocol: 'http',
        path: '/',
      });
    }

    const { data: healthRoutes } = await getRoutesByService(KONG_HEALTH_SERVICE);
    if (!healthRoutes?.length) {
      await createRoute(KONG_HEALTH_SERVICE, {
        paths: ['/health'],
        strip_path: false,
        preserve_host: false,
      });
    }

    console.log('[http-server] Kong routes registered');
  } catch (err) {
    console.error('[http-server] Failed to register Kong routes:', err.message);
  }
}

async function ensureBffConsumer(config, consumerName) {
  let consumer;
  try {
    consumer = await kong.get(`/consumers/${consumerName}`);
  } catch {
    consumer = await kong.post('/consumers', {
      username: consumerName,
      custom_id: 'bff',
    });
  }

  const { data: existingKeys } = await kong.get(`/consumers/${consumer.id}/key-auth`);

  // Only seed the key from .env if no key exists at all (first boot).
  // After rotation, Kong already has the correct key persisted — don't overwrite it.
  if (!existingKeys?.length) {
    await kong.post(`/consumers/${consumer.id}/key-auth`, { key: config.webhookSecret });
  } else {
    // Sync in-memory secret with what Kong has (survives rotation + restart).
    // This handles the case where the key was rotated but .env still has the old value.
    const kongKey = existingKeys[0].key;
    if (kongKey !== config.webhookSecret) {
      config.webhookSecret = kongKey;
      console.log('[http-server] Synced webhook secret from Kong (rotated key)');
    }
  }
}

/**
 * Sync the webhook secret with Kong's persisted key-auth credential.
 * Called on startup for ALL region types (HTTP and SQS) so the in-memory
 * secret survives rotation + container restart without updating .env.
 */
export async function syncWebhookSecret(config) {
  const consumerName = config.kongBffConsumerName || 'bff-commands';
  try {
    await ensureBffConsumer(config, consumerName);
  } catch (err) {
    console.error('[webhook-secret-sync] Failed:', err.message);
  }
}

export function startHttpServer(config) {
  _server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', regionId: config.regionId }));
      return;
    }

    // Internal model fetch — called by Lua scripts on first 200 response.
    // No HMAC required; only reachable within the Docker network.
    if (req.method === 'POST' && req.url === '/internal/model-fetch') {
      try {
        const rawBody = await readBody(req);
        const { providerId, url, providerType, callerHeaders } = JSON.parse(rawBody);
        if (!providerId || !url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing providerId or url' }));
          return;
        }
        // Skip if models are already cached
        if (await hasModels(providerId)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'CACHED' }));
          return;
        }
        // Run synchronously so Lua knows success vs failure for TTL
        const result = await routeCommand({ type: 'MODEL_FETCH', payload: { providerId, url, providerType, callerHeaders } });
        const count = result.result?.models?.length || 0;
        console.log(`[internal-model-fetch] ${providerId}: ${result.status} (${count} models)`);
        if (result.status === 'SUCCESS') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'SUCCESS', count }));
        } else {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'FAILED', error: result.result?.error }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method !== 'POST' || req.url !== '/api/commands') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    try {
      const rawBody = await readBody(req);

      const signature = req.headers['x-webhook-signature'];
      if (!signature) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing signature' }));
        return;
      }

      const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
      const expected = crypto.createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex');

      if (expected.length !== sig.length
        || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }

      const command = JSON.parse(rawBody);
      console.log(`[http-server] ${command.type} (${command.commandId})`);

      const result = await routeCommand(command);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[http-server] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'FAILED', result: { error: err.message } }));
    }
  });

  _server.listen(config.httpPort, () => {
    console.log(`[http-server] Listening on port ${config.httpPort}`);
    registerKongRoute(config);
  });
}

export function stopHttpServer() {
  if (_server) {
    _server.close();
    _server = null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
