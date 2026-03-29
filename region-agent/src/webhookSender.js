/**
 * HMAC-signed webhook sender.
 * Sends callback results to the global BFF with signature verification.
 */

import crypto from 'node:crypto';

/**
 * Send a signed callback to the global BFF.
 * Retries with exponential backoff.
 * @param {object} config - Application configuration
 * @param {object} payload - Callback payload
 */
export async function sendCallback(config, payload) {
  const MAX_RETRIES = config.webhookMaxRetries;
  const BASE_DELAY_MS = config.webhookBaseRetryDelayMs;
  const body = JSON.stringify(payload);
  const signature = createSignature(body, config.webhookSecret);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Region-Id': config.regionId,
        },
        body,
      });

      if (!response.ok) {
        throw new Error(`Webhook responded with ${response.status}: ${response.statusText}`);
      }

      console.log(`[webhook] Callback sent successfully for command ${payload.commandId}`);
      return;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[webhook] Attempt ${attempt + 1} failed, retrying in ${delay}ms:`, err.message);
        await sleep(delay);
      } else {
        console.error(`[webhook] All ${MAX_RETRIES + 1} attempts failed for command ${payload.commandId}:`, err.message);
        throw err;
      }
    }
  }
}

function createSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
