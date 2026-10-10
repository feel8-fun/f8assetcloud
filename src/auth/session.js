import { HttpError, assertAllowedCookieStateChange, isStateChangingRequestMethod } from '../common/http.js';
import { USER_ROLE_ADMIN, USER_ROLE_READONLY, normalizeUserRole } from '../common/identity.js';
import { stringOrDefault } from '../utils.js';
import { generateId } from 'better-auth';
import { bytesToHex, textEncoder } from '../common/crypto.js';
import { hashAuthPassword, verifyAuthPassword } from '../password.js';

const DESKTOP_ACCESS_TOKEN_TTL_SECONDS = 3600;

const DESKTOP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;

export const DESKTOP_REQUEST_PURGE_INTERVAL_MS = 60 * 1000;

let lastDesktopSessionPurgeByDb = new WeakMap();

export function resetSessionCaches() { lastDesktopSessionPurgeByDb = new WeakMap(); }

export async function requireAuthenticatedUser({ auth, db, request, allowedOrigins = null }) {
  const authState = await readAuthenticatedRequestState({ auth, db, request });
  if (authState === null) {
    throw new HttpError(401, 'authentication required');
  }
  if (authState.authType === 'cookie' && isStateChangingRequestMethod(request.method)) {
    assertAllowedCookieStateChange(allowedOrigins, request);
  }
  return authState.user;
}

export async function optionalAuthenticatedUser({ auth, db, request }) {
  const authState = await readAuthenticatedRequestState({ auth, db, request });
  return authState === null ? null : authState.user;
}

export async function requireManagementUser({ auth, db, request, allowedOrigins = null }) {
  const user = await requireAuthenticatedUser({ auth, db, request, allowedOrigins });
  if (!user.isAdmin) {
    throw new HttpError(403, 'management access required');
  }
  return user;
}

export async function requireAssetWriteUser({ auth, db, repo, request, allowedOrigins = null }) {
  const user = await requireAuthenticatedUser({ auth, db, request, allowedOrigins });
  const latestUser = await repo.getUserById(user.userId);
  if (latestUser === null) {
    throw new HttpError(401, 'authentication required');
  }
  if (latestUser.role === USER_ROLE_READONLY) {
    throw new HttpError(403, 'upload permission required');
  }
  return {
    ...user,
    role: latestUser.role,
    canUpload: latestUser.canUpload,
  };
}

async function readAuthenticatedRequestState({ auth, db, request }) {
  const bearerToken = readBearerTokenFromRequest(request);
  if (bearerToken !== null) {
    const user = await readDesktopAccessTokenUser({
      db,
      accessToken: bearerToken,
    });
    if (user === null) {
      throw new HttpError(401, 'authentication required');
    }
    return {
      authType: 'bearer',
      user,
    };
  }
  const cookieHeader = String(request.headers.get('cookie') || '').trim();
  if (!cookieHeader) {
    return null;
  }
  const session = await auth.api.getSession({
    headers: request.headers,
  });
  if (session === null || !session.user) {
    return null;
  }
  return {
    authType: 'cookie',
    user: toAppUser(session.user),
  };
}

function readBearerTokenFromRequest(request) {
  const headerValue = String(request.headers.get('authorization') || '').trim();
  if (!headerValue) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(headerValue);
  if (!match) {
    throw new HttpError(401, 'Authorization header must use Bearer token');
  }
  const token = String(match[1] || '').trim();
  if (!token) {
    throw new HttpError(401, 'Authorization header must use Bearer token');
  }
  return token;
}

export function toApiUser(user) {
  return {
    userId: user.userId,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    isAdmin: user.isAdmin,
    role: user.role,
    canUpload: user.canUpload,
  };
}

export function toAppUser(user) {
  const email = stringOrDefault(user.email, '');
  const name = stringOrDefault(user.name, email || String(user.id || ''));
  return {
    userId: String(user.id),
    name,
    email,
    emailVerified: Boolean(user.emailVerified),
    role: normalizeUserRole(user.role),
    isAdmin: normalizeUserRole(user.role) === USER_ROLE_ADMIN,
    canUpload: normalizeUserRole(user.role) !== USER_ROLE_READONLY,
  };
}

export function buildWorkerRateLimitKey({ namespace, request, identity = '' }) {
  const normalizedNamespace = String(namespace || '').trim() || 'unknown';
  const normalizedIdentity = String(identity || '').trim();
  if (normalizedIdentity) {
    return `worker:${normalizedNamespace}:${normalizedIdentity}`;
  }
  const forwardedIp = String(
    request.headers.get('cf-connecting-ip')
      || request.headers.get('x-forwarded-for')
      || '',
  )
    .split(',')[0]
    .trim();
  if (forwardedIp) {
    return `worker:${normalizedNamespace}:${forwardedIp}`;
  }
  const userAgent = String(request.headers.get('user-agent') || '').trim();
  if (userAgent) {
    return `worker:${normalizedNamespace}:ua:${userAgent.slice(0, 120)}`;
  }
  return `worker:${normalizedNamespace}:anonymous`;
}

export async function enforceWorkerRateLimit({ db, key, windowSeconds, maxRequests }) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    return;
  }
  const now = Date.now();
  const windowStart = now - (Number(windowSeconds) * 1000);
  const existing = await db.prepare(
    'SELECT count, lastRequest FROM rateLimit WHERE key = ?',
  )
    .bind(normalizedKey)
    .first();
  if (existing === null || Number(existing.lastRequest || 0) < windowStart) {
    await db.prepare(
      `INSERT INTO rateLimit (key, count, lastRequest)
       VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = 1,
         lastRequest = excluded.lastRequest`,
    )
      .bind(normalizedKey, now)
      .run();
    return;
  }
  const currentCount = Number(existing.count || 0);
  if (currentCount >= Number(maxRequests)) {
    throw new HttpError(429, 'rate limit exceeded');
  }
  await db.prepare(
    `UPDATE rateLimit
     SET count = ?, lastRequest = ?
     WHERE key = ?`,
  )
    .bind(currentCount + 1, now, normalizedKey)
    .run();
}

export async function readAppUserById(db, userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return null;
  }
  const row = await db.prepare(
    `SELECT id, name, email, emailVerified, role
     FROM user
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(normalizedUserId)
    .first();
  return row === null ? null : appUserFromDbRow(row);
}

async function readDesktopAccessTokenUser({ db, accessToken }) {
  const accessTokenHash = await hashOpaqueToken(accessToken);
  const row = await db.prepare(
    `SELECT
       u.id,
       u.name,
       u.email,
       u.emailVerified,
       u.role
     FROM desktop_sessions ds
     JOIN user u ON u.id = ds.user_id
     WHERE ds.access_token_hash = ?
       AND ds.access_token_expires_at > ?
       AND ds.revoked_at IS NULL
     LIMIT 1`,
  )
    .bind(accessTokenHash, Date.now())
    .first();
  return row === null ? null : appUserFromDbRow(row);
}

export function appUserFromDbRow(row) {
  return {
    userId: String(row.id),
    name: stringOrDefault(row.name, String(row.email || row.id || '')),
    email: stringOrDefault(row.email, ''),
    emailVerified: Number(row.emailVerified || 0) !== 0,
    role: normalizeUserRole(row.role),
    isAdmin: normalizeUserRole(row.role) === USER_ROLE_ADMIN,
    canUpload: normalizeUserRole(row.role) !== USER_ROLE_READONLY,
  };
}

export async function issueDesktopTokenPair({ db, user }) {
  await purgeExpiredDesktopSessionsIfDue(db);
  const now = Date.now();
  const accessToken = generateId(64);
  const refreshToken = generateId(64);
  const accessTokenExpiresAt = now + (DESKTOP_ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refreshTokenExpiresAt = now + (DESKTOP_REFRESH_TOKEN_TTL_SECONDS * 1000);
  await db.prepare(
    `INSERT INTO desktop_sessions (
       id,
       user_id,
       access_token_hash,
       access_token_expires_at,
       refresh_token_hash,
       refresh_token_expires_at,
       revoked_at,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      generateId(),
      String(user.userId),
      await hashOpaqueToken(accessToken),
      accessTokenExpiresAt,
      await hashOpaqueToken(refreshToken),
      refreshTokenExpiresAt,
      now,
      now,
    )
    .run();
  return {
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt,
    user,
  };
}

export function desktopAuthResponsePayload(desktopAuth) {
  return {
    accessToken: desktopAuth.accessToken,
    accessTokenExpiresAt: timestampIso(desktopAuth.accessTokenExpiresAt),
    refreshToken: desktopAuth.refreshToken,
    refreshTokenExpiresAt: timestampIso(desktopAuth.refreshTokenExpiresAt),
    user: toApiUser(desktopAuth.user),
  };
}

export async function refreshDesktopTokenPair({ db, refreshToken }) {
  await purgeExpiredDesktopSessionsIfDue(db);
  const refreshTokenHash = await hashOpaqueToken(refreshToken);
  const existing = await db.prepare(
    `SELECT
       ds.id,
       ds.user_id,
       u.id AS user_id_for_payload,
       u.name,
       u.email,
       u.emailVerified,
       u.role
     FROM desktop_sessions ds
     JOIN user u ON u.id = ds.user_id
     WHERE ds.refresh_token_hash = ?
       AND ds.refresh_token_expires_at > ?
       AND ds.revoked_at IS NULL
     LIMIT 1`,
  )
    .bind(refreshTokenHash, Date.now())
    .first();
  if (existing === null) {
    throw new HttpError(401, 'refreshToken is invalid or has expired');
  }
  const user = appUserFromDbRow({
    id: existing.user_id_for_payload,
    name: existing.name,
    email: existing.email,
    emailVerified: existing.emailVerified,
    role: existing.role,
  });
  const now = Date.now();
  const nextAccessToken = generateId(64);
  const nextRefreshToken = generateId(64);
  const nextAccessTokenExpiresAt = now + (DESKTOP_ACCESS_TOKEN_TTL_SECONDS * 1000);
  const nextRefreshTokenExpiresAt = now + (DESKTOP_REFRESH_TOKEN_TTL_SECONDS * 1000);
  const updateResult = await db.prepare(
    `UPDATE desktop_sessions
     SET access_token_hash = ?,
         access_token_expires_at = ?,
         refresh_token_hash = ?,
         refresh_token_expires_at = ?,
         updated_at = ?
     WHERE id = ?
       AND refresh_token_hash = ?
       AND revoked_at IS NULL`,
  )
    .bind(
      await hashOpaqueToken(nextAccessToken),
      nextAccessTokenExpiresAt,
      await hashOpaqueToken(nextRefreshToken),
      nextRefreshTokenExpiresAt,
      now,
      String(existing.id || ''),
      refreshTokenHash,
    )
    .run();
  if (Number(updateResult.meta?.changes || 0) < 1) {
    throw new HttpError(401, 'refreshToken is invalid or has expired');
  }
  return {
    accessToken: nextAccessToken,
    accessTokenExpiresAt: nextAccessTokenExpiresAt,
    refreshToken: nextRefreshToken,
    refreshTokenExpiresAt: nextRefreshTokenExpiresAt,
    user,
  };
}

export async function revokeDesktopRefreshToken({ db, refreshToken }) {
  const refreshTokenHash = await hashOpaqueToken(refreshToken);
  await db.prepare(
    `UPDATE desktop_sessions
     SET revoked_at = ?, updated_at = ?
     WHERE refresh_token_hash = ? AND revoked_at IS NULL`,
  )
    .bind(Date.now(), Date.now(), refreshTokenHash)
    .run();
}

async function purgeExpiredDesktopSessions(db) {
  await db.prepare(
    `DELETE FROM desktop_sessions
     WHERE refresh_token_expires_at < ?
        OR revoked_at IS NOT NULL`,
  )
    .bind(Date.now())
    .run();
}

async function purgeExpiredDesktopSessionsIfDue(db) {
  if (!shouldRunDbIntervalTask(lastDesktopSessionPurgeByDb, db, DESKTOP_REQUEST_PURGE_INTERVAL_MS)) {
    return;
  }
  await purgeExpiredDesktopSessions(db);
}

export function shouldRunDbIntervalTask(lastRunByDb, db, intervalMs) {
  const now = Date.now();
  const lastRunAt = Number(lastRunByDb.get(db) || 0);
  if (lastRunAt > 0 && now - lastRunAt < intervalMs) {
    return false;
  }
  lastRunByDb.set(db, now);
  return true;
}

export async function hashOpaqueToken(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(String(value || '')),
  );
  return bytesToHex(new Uint8Array(digest));
}

function timestampIso(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '';
  }
  return new Date(timestamp).toISOString();
}

export async function updateAppUserName(db, { userId, name }) {
  await db.prepare(
    `UPDATE user
     SET name = ?, updatedAt = ?
     WHERE id = ?`,
  )
    .bind(String(name), Date.now(), String(userId))
    .run();
}

export async function changeAppUserPassword(db, { userId, currentPassword, newPassword }) {
  const account = await db.prepare(
    `SELECT id, password
     FROM account
     WHERE userId = ? AND providerId = 'credential'
     LIMIT 1`,
  )
    .bind(String(userId))
    .first();
  if (account === null || !String(account.password || '').trim()) {
    throw new HttpError(400, 'password authentication is unavailable for this account');
  }
  const isCurrentPasswordValid = await verifyAuthPassword({
    hash: String(account.password || ''),
    password: currentPassword,
  });
  if (!isCurrentPasswordValid) {
    throw new HttpError(400, 'currentPassword is invalid');
  }
  await db.prepare(
    `UPDATE account
     SET password = ?, updatedAt = ?
     WHERE id = ?`,
  )
    .bind(await hashAuthPassword(newPassword), Date.now(), String(account.id || ''))
    .run();
  await clearAppUserSessions(db, userId);
}

async function clearAppUserSessions(db, userId) {
  await db.prepare('DELETE FROM session WHERE userId = ?')
    .bind(String(userId))
    .run();
  await db.prepare('DELETE FROM desktop_sessions WHERE user_id = ?')
    .bind(String(userId))
    .run();
}
