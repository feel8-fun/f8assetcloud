import { isPlainObject, stringOrDefault } from '../utils.js';
import { ApiException } from 'chanfana';
import { AssetConflictError, AssetNotFoundError, AssetPermissionError, AssetValidationError } from '../repository.js';
import { CloudError } from '../library/contracts.ts';
import { ZodError } from 'zod';

const MAX_REQUEST_COMPRESSED_BYTES = 12 * 1024 * 1024;

const MAX_REQUEST_JSON_BYTES = 12 * 1024 * 1024;

const PUBLIC_CACHE_CONTROL_HEADER = 'public, max-age=120, stale-while-revalidate=300';

export function requireFormString(value, message) {
  if (typeof value !== 'string') {
    throw new HttpError(400, message);
  }
  const text = value.trim();
  if (!text) {
    throw new HttpError(400, message);
  }
  return text;
}

export function buildSetCookieHeader({ name, value, request, path = '/', maxAgeSeconds = 0 }) {
  const parts = [
    `${String(name || '').trim()}=${encodeURIComponent(String(value || '').trim())}`,
    `Path=${path}`,
    `Max-Age=${Math.max(0, Number(maxAgeSeconds) || 0)}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (new URL(request.url).protocol === 'https:') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function readCookieValueFromHeader(cookieHeader, cookieName) {
  const normalizedCookieName = String(cookieName || '').trim();
  if (!normalizedCookieName) {
    return '';
  }
  const rawHeader = String(cookieHeader || '');
  if (!rawHeader.trim()) {
    return '';
  }
  const cookies = rawHeader.split(';');
  for (const item of cookies) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const name = trimmed.slice(0, separatorIndex).trim();
    if (name !== normalizedCookieName) {
      continue;
    }
    return decodeURIComponent(trimmed.slice(separatorIndex + 1).trim());
  }
  return '';
}

export function isStateChangingRequestMethod(method) {
  const normalizedMethod = String(method || '').trim().toUpperCase();
  return normalizedMethod === 'POST'
    || normalizedMethod === 'PUT'
    || normalizedMethod === 'PATCH'
    || normalizedMethod === 'DELETE';
}

export function assertAllowedCookieStateChange(allowedOrigins, request) {
  if (!isStateChangingRequestMethod(request.method)) {
    return;
  }
  const origin = String(request.headers.get('origin') || '').trim();
  if (!origin) {
    throw new HttpError(403, 'Origin header is required');
  }
  if (!isAllowedOrigin(allowedOrigins, origin)) {
    throw new HttpError(403, 'Origin is not allowed');
  }
}

function isAllowedOrigin(allowedOrigins, origin) {
  const normalizedOrigin = String(origin || '').trim();
  if (!normalizedOrigin) {
    return false;
  }
  for (const allowedOrigin of normalizeAllowedOrigins(allowedOrigins)) {
    if (allowedOrigin === normalizedOrigin) {
      return true;
    }
  }
  return false;
}

function normalizeAllowedOrigins(allowedOrigins) {
  if (allowedOrigins instanceof Set) {
    return [...allowedOrigins].map((value) => String(value || '').trim()).filter(Boolean);
  }
  if (Array.isArray(allowedOrigins)) {
    return allowedOrigins.map((value) => String(value || '').trim()).filter(Boolean);
  }
  return [];
}

export function copyHeaderIfPresent(sourceHeaders, targetHeaders, headerName) {
  const value = sourceHeaders.get(headerName);
  if (value) {
    targetHeaders.set(headerName, value);
  }
}

function htmlResponse(status, html) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function resolveAuthBaseUrl(env, requestUrl) {
  const configured = String(env.AUTH_BASE_URL || '').trim();
  if (!configured) {
    throw new HttpError(500, 'AUTH_BASE_URL is not configured');
  }
  try {
    return new URL(configured).toString().replace(/\/+$/g, '');
  } catch (error) {
    throw new HttpError(500, 'AUTH_BASE_URL must be a valid absolute URL');
  }
}

export function calculateAllowedOrigins(env, requestUrl = null) {
  const origins = new Set();
  addOrigin(origins, resolveAuthBaseUrl(env));
  addLoopbackRequestOrigin(origins, requestUrl);
  const extra = String(env.CORS_ALLOWED_ORIGINS || '').trim();
  if (extra) {
    for (const value of extra.split(',')) {
      addOrigin(origins, value);
    }
  }
  return origins;
}

export function resolveTrustedOrigins(env, requestUrl, baseURL) {
  return [...calculateAllowedOrigins(env, requestUrl)];
}

function addOrigin(target, value) {
  const text = String(value || '').trim();
  if (!text) {
    return;
  }
  try {
    target.add(new URL(text).origin);
  } catch (error) {
    console.warn('Ignoring invalid trusted origin', text);
  }
}

function addLoopbackRequestOrigin(target, requestUrl) {
  if (!(requestUrl instanceof URL)) {
    return;
  }
  if (!isLoopbackHostname(requestUrl.hostname)) {
    return;
  }
  target.add(requestUrl.origin);
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

export function resolveAllowedOrigin(env, origin, requestUrl = null) {
  const normalizedOrigin = String(origin || '').trim();
  if (!normalizedOrigin) {
    return null;
  }
  return isAllowedOrigin(calculateAllowedOrigins(env, requestUrl), normalizedOrigin) ? normalizedOrigin : null;
}

export function decodeSinglePathValue(pathname, prefix) {
  const value = decodeURIComponent(pathname.slice(prefix.length));
  if (!value || value.includes('/')) {
    return '';
  }
  return value;
}

export async function readJsonBody(request) {
  const contentEncoding = String(request.headers.get('Content-Encoding') || '').toLowerCase();
  let raw = '';
  if (contentEncoding.includes('gzip')) {
    const compressedBody = await readRequestBytesWithLimit(request, MAX_REQUEST_COMPRESSED_BYTES);
    if (compressedBody.byteLength === 0) {
      return {};
    }
    try {
      raw = await decompressGzipBodyWithLimit(compressedBody, MAX_REQUEST_JSON_BYTES);
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(400, 'request body gzip decompression failed');
    }
  } else {
    raw = await readRequestTextWithLimit(request, MAX_REQUEST_JSON_BYTES);
  }
  if (!raw) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  if (!isPlainObject(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return parsed;
}

async function readRequestTextWithLimit(request, maxBytes) {
  const bytes = await readRequestBytesWithLimit(request, maxBytes);
  return new TextDecoder().decode(bytes);
}

async function readRequestBytesWithLimit(request, maxBytes) {
  if (request.body === null) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > Number(maxBytes)) {
      throw new HttpError(413, 'request body is too large');
    }
    chunks.push(chunk);
  }
  return concatUint8Arrays(chunks, totalBytes);
}

async function decompressGzipBodyWithLimit(buffer, maxBytes) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > Number(maxBytes)) {
      throw new HttpError(413, 'request body is too large');
    }
    output += decoder.decode(chunk, { stream: true });
  }
  output += decoder.decode();
  return output;
}

function concatUint8Arrays(chunks, totalBytes) {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function handleError(error) {
  if (error instanceof CloudError) return jsonResponse(error.status,{code:error.code,message:error.message});
  if (error instanceof ZodError) return jsonResponse(400,{code:'invalid_request',message:error.message});
  if (error instanceof HttpError) {
    return jsonResponse(error.status, { message: error.message, ...error.payload });
  }
  if (error instanceof ApiException) {
    const errors = error.buildResponse();
    const primaryMessage = errors.length > 0 ? String(errors[0].message || '') : String(error.message || '');
    return jsonResponse(error.status, {
      message: primaryMessage || 'request failed',
      errors,
    });
  }
  const apiError = toAuthApiErrorPayload(error);
  if (apiError !== null) {
    return jsonResponse(apiError.status, apiError.payload);
  }
  if (error instanceof AssetPermissionError) {
    return jsonResponse(403, { message: 'forbidden' });
  }
  if (error instanceof AssetNotFoundError) {
    return jsonResponse(404, { message: 'asset not found' });
  }
  if (error instanceof AssetConflictError) {
    const payload = {
      message: 'conflict',
      versionNumber: error.versionNumber,
    };
    if (error.assetType === 'variant') {
      payload.variantId = error.assetId;
    } else if (error.assetType === 'modding_recipe') {
      payload.recipeId = error.assetId;
    } else {
      payload.componentId = error.assetId;
    }
    return jsonResponse(409, payload);
  }
  if (error instanceof AssetValidationError) {
    return jsonResponse(400, { message: error.message });
  }
  if (error instanceof Error && isUniqueConstraintError(error)) {
    return jsonResponse(409, { message: 'duplicate resource' });
  }
  if (error instanceof Error && error.message) {
    if (error.message.includes('already exists') || error.message.includes('duplicate')) {
      return jsonResponse(409, { message: 'duplicate resource' });
    }
  }
  console.error('Unhandled asset worker error', error);
  return jsonResponse(500, { message: 'internal error' });
}

function toAuthApiErrorPayload(error) {
  const status = Number(error?.statusCode || 0);
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    return null;
  }
  const body = isPlainObject(error?.body) ? error.body : {};
  const message = body.message ? String(body.message) : (error instanceof Error ? error.message : 'request failed');
  const payload = {
    ...body,
    message,
  };
  return { status, payload };
}

function isUniqueConstraintError(error) {
  const message = error instanceof Error ? error.message : '';
  const causeMessage = error?.cause instanceof Error ? error.cause.message : '';
  const causeErrcode = Number(error?.cause?.errcode || 0);
  return (
    message.includes('UNIQUE constraint failed')
    || causeMessage.includes('UNIQUE constraint failed')
    || causeErrcode === 2067
  );
}

export function jsonResponse(status, payload, extraHeaders = null) {
  const headers = new Headers({
    'Content-Type': 'application/json',
  });
  appendHeaders(headers, extraHeaders);
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

export function assetDownloadResponse(payload, { head, versionNumber, headers: extraHeaders = null }) {
  const baseName = stringOrDefault(head && head.name, String(head ? head.asset_id : 'asset'));
  const slug = slugifyForFilename(baseName) || 'asset';
  const versionSuffix = Number.isFinite(Number(versionNumber)) ? `-${Number(versionNumber)}` : '';
  const filename = `${slug}${versionSuffix}.json`;
  const body = JSON.stringify(payload, null, 2);
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  appendHeaders(headers, extraHeaders);
  return new Response(body, {
    status: 200,
    headers,
  });
}

function appendHeaders(targetHeaders, sourceHeaders) {
  if (!sourceHeaders) {
    return;
  }
  const iterable = sourceHeaders instanceof Headers
    ? sourceHeaders.entries()
    : Object.entries(sourceHeaders);
  for (const [key, value] of iterable) {
    if (value === null || value === undefined || String(value).trim() === '') {
      continue;
    }
    targetHeaders.set(key, String(value));
  }
}

function isAnonymousRequest(request) {
  return !String(request.headers.get('authorization') || '').trim()
    && !String(request.headers.get('cookie') || '').trim();
}

export function anonymousPublicResponseHeaders(request, shouldCache) {
  if (!shouldCache || !isAnonymousRequest(request)) {
    return null;
  }
  return {
    'Cache-Control': PUBLIC_CACHE_CONTROL_HEADER,
    Vary: 'Authorization, Cookie',
  };
}

export function applyAnonymousPublicCacheHeaders(c, request, shouldCache) {
  const headers = anonymousPublicResponseHeaders(request, shouldCache);
  if (!headers) {
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    c.header(key, value);
  }
}

function slugifyForFilename(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function secondsFromEnv(value, fallback) {
  const parsed = Number.parseInt(String(value || fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function requireBodyString(value, message) {
  const text = String(value || '').trim();
  if (!text) {
    throw new HttpError(400, message);
  }
  return text;
}

export function requireQueryString(value, message) {
  const text = String(value || '').trim();
  if (!text) {
    throw new HttpError(400, message);
  }
  return text;
}

export class HttpError extends Error {
  constructor(status, message, payload = {}) {
    super(String(message || 'request failed'));
    this.status = status;
    this.payload = payload;
  }
}
