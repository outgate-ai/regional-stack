/**
 * HTTP client wrapper for Kong Admin API.
 * Provides GET, POST, PUT, PATCH, DELETE methods with JSON handling.
 */

import { getConfig } from '../config.js';

/**
 * Make an HTTP request to the Kong Admin API.
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g., /services)
 * @param {object} [body] - Request body (for POST/PUT/PATCH)
 * @returns {Promise<object|null>} Response body or null for 204
 */
async function request(method, path, body) {
  const config = getConfig();
  const url = `${config.kongAdminUrl}${path}`;

  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };

  if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
    opts.body = JSON.stringify(body);
  }

  const response = await fetch(url, opts);

  // 204 No Content
  if (response.status === 204) return null;

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const msg = data?.message || data?.error || response.statusText;
    const err = new Error(`Kong API ${method} ${path} failed (${response.status}): ${msg}`);
    err.status = response.status;
    err.body = data;
    throw err;
  }

  return data;
}

export function get(path) {
  return request('GET', path);
}

export function post(path, body) {
  return request('POST', path, body);
}

export function put(path, body) {
  return request('PUT', path, body);
}

export function patch(path, body) {
  return request('PATCH', path, body);
}

export function del(path) {
  return request('DELETE', path);
}
