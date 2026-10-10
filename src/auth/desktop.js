import { generateId } from 'better-auth';
import { DESKTOP_REQUEST_PURGE_INTERVAL_MS, appUserFromDbRow, buildWorkerRateLimitKey, desktopAuthResponsePayload, enforceWorkerRateLimit, hashOpaqueToken, issueDesktopTokenPair, readAppUserById, refreshDesktopTokenPair, revokeDesktopRefreshToken, shouldRunDbIntervalTask, toAppUser } from './session.js';
import { hasGoogleProvider } from './runtime.js';
import { HttpError, assertAllowedCookieStateChange, buildSetCookieHeader, calculateAllowedOrigins, copyHeaderIfPresent, escapeHtml, jsonResponse, readCookieValueFromHeader, readJsonBody, requireBodyString, requireFormString, requireQueryString } from '../common/http.js';
import { AUTH_BASE_PATH } from '../common/paths.js';
import { textEncoder } from '../common/crypto.js';

export const DESKTOP_AUTH_BASE_PATH = '/v1/auth/desktop';

const DESKTOP_AUTHORIZATION_CODE_TTL_SECONDS = 300;

const DESKTOP_AUTH_CONFIRM_CSRF_COOKIE = 'f8assetcloud_desktop_csrf';

const DESKTOP_AUTH_ALLOWED_CLIENT_IDS = new Set(['f8studio']);

let lastDesktopAuthorizationCodePurgeByDb = new WeakMap();

export function resetDesktopCaches() { lastDesktopAuthorizationCodePurgeByDb = new WeakMap(); }

export async function routeDesktopAuthorizeGet({ auth, db, env, request, siteSettings }) {
  const requestUrl = new URL(request.url);
  const authorizeRequest = parseDesktopAuthorizeRequestFromUrl(requestUrl);
  assertAllowedDesktopClientId(authorizeRequest.clientId);
  await enforceWorkerRateLimit({
    db,
    key: buildWorkerRateLimitKey({ namespace: 'desktop_authorize_get', request }),
    windowSeconds: 60,
    maxRequests: 30,
  });
  const socialProvider = desktopAuthorizeSocialProvider(requestUrl);
  const errorMessage = desktopAuthorizeErrorMessage(requestUrl);
  const allowRegistration = Boolean(siteSettings?.allowUserRegistration);
  const allowDesktopGoogle = allowRegistration && hasGoogleProvider(env);
  const session = await auth.api.getSession({
    headers: request.headers,
  });
  const currentUser = session === null || !session.user ? null : toAppUser(session.user);
  const pageCsrfToken = generateId(32);
  if (socialProvider) {
    if (!allowRegistration) {
      return desktopAuthorizePageResponse(
        400,
        buildDesktopAuthorizeHtml({
          request: authorizeRequest,
          allowGoogle: false,
          allowRegistration: false,
          currentUser,
          csrfToken: pageCsrfToken,
          errorMessage: 'Google sign-in is unavailable while registration is disabled.',
          email: '',
        }),
        request,
        pageCsrfToken,
      );
    }
    if (socialProvider !== 'google') {
      throw new HttpError(400, `unsupported social provider: ${socialProvider}`);
    }
    if (!allowDesktopGoogle) {
      throw new HttpError(400, 'Google sign-in is not configured');
    }
    return startDesktopSocialSignIn({
      auth,
      request,
      providerId: socialProvider,
      callbackURL: desktopAuthorizeResumeUrl(requestUrl),
      errorCallbackURL: desktopAuthorizeErrorCallbackUrl(requestUrl),
    });
  }
  return desktopAuthorizePageResponse(
    200,
    buildDesktopAuthorizeHtml({
      request: authorizeRequest,
      allowGoogle: allowDesktopGoogle,
      allowRegistration,
      currentUser,
      csrfToken: pageCsrfToken,
      errorMessage,
      email: '',
    }),
    request,
    pageCsrfToken,
  );
}

export async function routeDesktopAuthorizePost({ auth, db, env, request, siteSettings }) {
  assertAllowedCookieStateChange(calculateAllowedOrigins(env), request);
  await enforceWorkerRateLimit({
    db,
    key: buildWorkerRateLimitKey({ namespace: 'desktop_authorize_post', request }),
    windowSeconds: 60,
    maxRequests: 20,
  });
  const form = await request.formData();
  const authorizeRequest = parseDesktopAuthorizeRequestFromForm(form);
  assertAllowedDesktopClientId(authorizeRequest.clientId);
  validateDesktopAuthorizeCsrf({ request, form });
  const email = String(form.get('email') || '').trim();
  const password = String(form.get('password') || '');
  const allowRegistration = Boolean(siteSettings?.allowUserRegistration);
  const allowGoogle = allowRegistration && hasGoogleProvider(env);
  const existingSession = await auth.api.getSession({
    headers: request.headers,
  });
  try {
    let userId = '';
    if (existingSession !== null && existingSession.user && !email && !password) {
      userId = String(existingSession.user.id || '').trim();
    } else {
      const normalizedEmail = requireFormString(email, 'email is required');
      const normalizedPassword = requireFormString(password, 'password is required');
      const sessionCookie = await signInDesktopBrowserUser({
        auth,
        authorizeUrl: request.url,
        request,
        email: normalizedEmail,
        password: normalizedPassword,
      });
      const sessionHeaders = new Headers();
      sessionHeaders.set('cookie', sessionCookie);
      const signedInSession = await auth.api.getSession({
        headers: sessionHeaders,
      });
      if (signedInSession === null || !signedInSession.user) {
        throw new HttpError(401, 'browser session is no longer valid');
      }
      userId = String(signedInSession.user.id || '').trim();
    }
    if (!userId) {
      throw new HttpError(401, 'browser session is no longer valid');
    }
    return redirectWithDesktopAuthorizationCode({
      db,
      desktopRequest: authorizeRequest,
      userId,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      const pageCsrfToken = generateId(32);
      return desktopAuthorizePageResponse(
        error.status,
        buildDesktopAuthorizeHtml({
          request: authorizeRequest,
          allowGoogle,
          allowRegistration,
          currentUser: existingSession === null || !existingSession.user ? null : toAppUser(existingSession.user),
          csrfToken: pageCsrfToken,
          errorMessage: error.message,
          email,
        }),
        request,
        pageCsrfToken,
      );
    }
    throw error;
  }
}

export async function routeDesktopTokenPost({ db, request }) {
  await enforceWorkerRateLimit({
    db,
    key: buildWorkerRateLimitKey({ namespace: 'desktop_token', request }),
    windowSeconds: 60,
    maxRequests: 20,
  });
  const payload = await readJsonBody(request);
  const code = requireBodyString(payload.code, 'code is required');
  const clientId = requireBodyString(payload.clientId ?? payload.client_id, 'clientId is required');
  const redirectUri = requireBodyString(payload.redirectUri ?? payload.redirect_uri, 'redirectUri is required');
  const codeVerifier = requireBodyString(payload.codeVerifier ?? payload.code_verifier, 'codeVerifier is required');
  assertAllowedDesktopClientId(clientId);
  requireLoopbackRedirectUri(redirectUri);
  const record = await loadDesktopAuthorizationCodeRecord(db, code);
  if (record === null) {
    throw new HttpError(400, 'authorization code is invalid or has expired');
  }
  if (record.usedAt !== null) {
    throw new HttpError(400, 'authorization code has already been used');
  }
  if (record.expiresAt <= Date.now()) {
    throw new HttpError(400, 'authorization code has expired');
  }
  if (record.clientId !== clientId) {
    throw new HttpError(400, 'clientId does not match the authorization request');
  }
  if (record.redirectUri !== redirectUri) {
    throw new HttpError(400, 'redirectUri does not match the authorization request');
  }
  if (record.codeChallengeMethod !== 'S256') {
    throw new HttpError(400, 'unsupported code_challenge_method');
  }
  const computedChallenge = await computePkceCodeChallenge(codeVerifier);
  if (computedChallenge !== record.codeChallenge) {
    throw new HttpError(400, 'codeVerifier is invalid');
  }
  if (record.user === null) {
    throw new HttpError(401, 'browser session is no longer valid');
  }
  const usedAt = Date.now();
  const updateResult = await db.prepare(
    'UPDATE desktop_authorization_codes SET used_at = ? WHERE code = ? AND used_at IS NULL',
  )
    .bind(usedAt, code)
    .run();
  if (Number(updateResult.meta?.changes || 0) < 1) {
    throw new HttpError(400, 'authorization code has already been used');
  }
  const desktopAuth = await issueDesktopTokenPair({
    db,
    user: record.user,
  });
  return jsonResponse(200, desktopAuthResponsePayload(desktopAuth));
}

export async function routeDesktopSessionPost({ auth, db, request, allowedOrigins }) {
  assertAllowedCookieStateChange(allowedOrigins, request);
  await enforceWorkerRateLimit({
    db,
    key: buildWorkerRateLimitKey({ namespace: 'desktop_session_exchange', request }),
    windowSeconds: 60,
    maxRequests: 12,
  });
  const session = await auth.api.getSession({
    headers: request.headers,
  });
  if (session === null || !session.user) {
    throw new HttpError(401, 'authentication required');
  }
  const user = await readAppUserById(db, String(session.user.id || ''));
  if (user === null) {
    throw new HttpError(401, 'authentication required');
  }
  return jsonResponse(200, desktopAuthResponsePayload(await issueDesktopTokenPair({ db, user })));
}

export async function routeDesktopRefreshPost({ db, request }) {
  const payload = await readJsonBody(request);
  const refreshToken = requireBodyString(payload.refreshToken ?? payload.refresh_token, 'refreshToken is required');
  await enforceWorkerRateLimit({
    db,
    key: `worker:desktop_refresh:${await hashOpaqueToken(refreshToken)}`,
    windowSeconds: 60,
    maxRequests: 20,
  });
  return jsonResponse(200, desktopAuthResponsePayload(await refreshDesktopTokenPair({
    db,
    refreshToken,
  })));
}

export async function routeDesktopRevokePost({ db, request }) {
  const payload = await readJsonBody(request);
  const refreshToken = requireBodyString(payload.refreshToken ?? payload.refresh_token, 'refreshToken is required');
  await revokeDesktopRefreshToken({
    db,
    refreshToken,
  });
  return jsonResponse(200, { revoked: true });
}

function parseDesktopAuthorizeRequestFromUrl(url) {
  const clientId = requireQueryString(url.searchParams.get('client_id') || url.searchParams.get('clientId'), 'client_id is required');
  const redirectUri = requireLoopbackRedirectUri(
    requireQueryString(url.searchParams.get('redirect_uri') || url.searchParams.get('redirectUri'), 'redirect_uri is required'),
  );
  const state = requireQueryString(url.searchParams.get('state'), 'state is required');
  const codeChallenge = requireQueryString(
    url.searchParams.get('code_challenge') || url.searchParams.get('codeChallenge'),
    'code_challenge is required',
  );
  const codeChallengeMethod = requireQueryString(
    url.searchParams.get('code_challenge_method') || url.searchParams.get('codeChallengeMethod'),
    'code_challenge_method is required',
  );
  if (codeChallengeMethod !== 'S256') {
    throw new HttpError(400, 'code_challenge_method must be S256');
  }
  return {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
  };
}

function parseDesktopAuthorizeRequestFromForm(form) {
  const clientId = requireFormString(form.get('client_id') || form.get('clientId'), 'client_id is required');
  const redirectUri = requireLoopbackRedirectUri(
    requireFormString(form.get('redirect_uri') || form.get('redirectUri'), 'redirect_uri is required'),
  );
  const state = requireFormString(form.get('state'), 'state is required');
  const codeChallenge = requireFormString(
    form.get('code_challenge') || form.get('codeChallenge'),
    'code_challenge is required',
  );
  const codeChallengeMethod = requireFormString(
    form.get('code_challenge_method') || form.get('codeChallengeMethod'),
    'code_challenge_method is required',
  );
  if (codeChallengeMethod !== 'S256') {
    throw new HttpError(400, 'code_challenge_method must be S256');
  }
  return {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
  };
}

function requireLoopbackRedirectUri(value) {
  const redirectUri = String(value || '').trim();
  if (!redirectUri) {
    throw new HttpError(400, 'redirect_uri is required');
  }
  let parsed;
  try {
    parsed = new URL(redirectUri);
  } catch (error) {
    throw new HttpError(400, 'redirect_uri must be a valid URL');
  }
  const hostname = String(parsed.hostname || '').trim().toLowerCase();
  const allowedHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (parsed.protocol !== 'http:' || !allowedHost) {
    throw new HttpError(400, 'redirect_uri must use http://127.0.0.1, http://localhost, or http://[::1]');
  }
  return parsed.toString();
}

async function signInDesktopBrowserUser({ auth, authorizeUrl, request, email, password }) {
  const headers = new Headers();
  headers.set('Accept', 'application/json');
  headers.set('Content-Type', 'application/json');
  headers.set('Origin', new URL(request.url).origin);
  headers.set('Referer', authorizeUrl);
  copyHeaderIfPresent(request.headers, headers, 'User-Agent');
  copyHeaderIfPresent(request.headers, headers, 'Accept-Language');
  const signInRequest = new Request(new URL(`${AUTH_BASE_PATH}/sign-in/email`, request.url), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email,
      password,
    }),
  });
  const signInResponse = await auth.handler(signInRequest);
  const responseText = await signInResponse.text();
  if (!signInResponse.ok) {
    let message = `sign-in failed with HTTP ${signInResponse.status}`;
    if (responseText) {
      try {
        const parsed = JSON.parse(responseText);
        message = errorMessageFromPayload(parsed) || message;
      } catch {
        message = responseText;
      }
    }
    throw new HttpError(signInResponse.status, message);
  }
  const sessionCookie = extractCookieFromSetCookie(signInResponse.headers.get('set-cookie') || '');
  if (!sessionCookie) {
    throw new HttpError(500, 'sign-in succeeded but no session cookie was returned');
  }
  return sessionCookie;
}

async function startDesktopSocialSignIn({ auth, request, providerId, callbackURL, errorCallbackURL }) {
  const headers = new Headers();
  headers.set('Accept', 'application/json');
  headers.set('Content-Type', 'application/json');
  headers.set('Origin', new URL(request.url).origin);
  headers.set('Referer', request.url);
  copyHeaderIfPresent(request.headers, headers, 'User-Agent');
  copyHeaderIfPresent(request.headers, headers, 'Accept-Language');
  const socialRequest = new Request(new URL(`${AUTH_BASE_PATH}/sign-in/social`, request.url), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      provider: providerId,
      callbackURL,
      errorCallbackURL,
    }),
  });
  const socialResponse = await auth.handler(socialRequest);
  const responseText = await socialResponse.text();
  if (!socialResponse.ok) {
    let message = `social sign-in failed with HTTP ${socialResponse.status}`;
    if (responseText) {
      try {
        const parsed = JSON.parse(responseText);
        message = errorMessageFromPayload(parsed) || message;
      } catch {
        message = responseText;
      }
    }
    throw new HttpError(socialResponse.status, message);
  }
  let authorizationUrl = String(socialResponse.headers.get('location') || '').trim();
  if (!authorizationUrl) {
    try {
      const payload = JSON.parse(responseText);
      if (payload && typeof payload.url === 'string') {
        authorizationUrl = String(payload.url).trim();
      }
    } catch {
      authorizationUrl = '';
    }
  }
  if (!authorizationUrl) {
    throw new HttpError(500, 'social sign-in did not return an authorization URL');
  }
  const redirectHeaders = new Headers();
  const setCookie = socialResponse.headers.get('set-cookie');
  if (setCookie) {
    redirectHeaders.set('set-cookie', setCookie);
  }
  redirectHeaders.set('Cache-Control', 'no-store');
  redirectHeaders.set('Location', authorizationUrl);
  return new Response(null, {
    status: 302,
    headers: redirectHeaders,
  });
}

async function redirectWithDesktopAuthorizationCode({ db, desktopRequest, userId }) {
  await purgeExpiredDesktopAuthorizationCodesIfDue(db);
  const now = Date.now();
  const code = generateId(48);
  const expiresAt = now + DESKTOP_AUTHORIZATION_CODE_TTL_SECONDS * 1000;
  await db.prepare(
    `INSERT INTO desktop_authorization_codes
      (code, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, created_at, expires_at, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      code,
      String(userId),
      desktopRequest.clientId,
      desktopRequest.redirectUri,
      desktopRequest.codeChallenge,
      desktopRequest.codeChallengeMethod,
      now,
      expiresAt,
    )
    .run();
  const redirectUrl = new URL(desktopRequest.redirectUri);
  redirectUrl.searchParams.set('code', code);
  redirectUrl.searchParams.set('state', desktopRequest.state);
  return Response.redirect(redirectUrl.toString(), 302);
}

async function loadDesktopAuthorizationCodeRecord(db, code) {
  await purgeExpiredDesktopAuthorizationCodesIfDue(db);
  const row = await db.prepare(
    `SELECT
      dac.code,
      dac.user_id,
      dac.client_id,
      dac.redirect_uri,
      dac.code_challenge,
      dac.code_challenge_method,
      dac.created_at,
      dac.expires_at,
      dac.used_at,
      u.id,
      u.name,
      u.email,
      u.emailVerified,
      u.role
    FROM desktop_authorization_codes dac
    LEFT JOIN user u ON u.id = dac.user_id
    WHERE dac.code = ?`,
  )
    .bind(code)
    .first();
  if (row === null) {
    return null;
  }
  return {
    code: String(row.code || ''),
    userId: String(row.user_id || ''),
    clientId: String(row.client_id || ''),
    redirectUri: String(row.redirect_uri || ''),
    codeChallenge: String(row.code_challenge || ''),
    codeChallengeMethod: String(row.code_challenge_method || ''),
    createdAt: Number(row.created_at || 0),
    expiresAt: Number(row.expires_at || 0),
    usedAt: row.used_at === null || row.used_at === undefined ? null : Number(row.used_at),
    user: row.id === null || row.id === undefined ? null : appUserFromDbRow(row),
  };
}

async function purgeExpiredDesktopAuthorizationCodes(db) {
  await db.prepare('DELETE FROM desktop_authorization_codes WHERE expires_at < ?')
    .bind(Date.now())
    .run();
}

async function purgeExpiredDesktopAuthorizationCodesIfDue(db) {
  if (!shouldRunDbIntervalTask(lastDesktopAuthorizationCodePurgeByDb, db, DESKTOP_REQUEST_PURGE_INTERVAL_MS)) {
    return;
  }
  await purgeExpiredDesktopAuthorizationCodes(db);
}

function assertAllowedDesktopClientId(clientId) {
  const normalizedClientId = String(clientId || '').trim();
  if (!DESKTOP_AUTH_ALLOWED_CLIENT_IDS.has(normalizedClientId)) {
    throw new HttpError(400, 'clientId is not allowed');
  }
}

function desktopAuthorizePageResponse(status, html, request, csrfToken) {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', buildSetCookieHeader({
    name: DESKTOP_AUTH_CONFIRM_CSRF_COOKIE,
    value: csrfToken,
    request,
    path: `${DESKTOP_AUTH_BASE_PATH}/authorize`,
    maxAgeSeconds: DESKTOP_AUTHORIZATION_CODE_TTL_SECONDS,
  }));
  return new Response(html, {
    status,
    headers,
  });
}

function validateDesktopAuthorizeCsrf({ request, form }) {
  const formToken = requireFormString(
    form.get('csrf_token') || form.get('csrfToken'),
    'csrf token is required',
  );
  const cookieToken = readCookieValueFromHeader(request.headers.get('cookie'), DESKTOP_AUTH_CONFIRM_CSRF_COOKIE);
  if (!cookieToken || cookieToken !== formToken) {
    throw new HttpError(403, 'desktop authorization form is invalid');
  }
}

function extractCookieFromSetCookie(setCookieHeader) {
  const text = String(setCookieHeader || '').trim();
  if (!text) {
    return '';
  }
  const firstPart = text.split(';')[0];
  return String(firstPart || '').trim();
}

function extractSessionCookieFromCookieHeader({ cookieHeader, sessionToken }) {
  const token = String(sessionToken || '').trim();
  if (!token) {
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
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (value === token) {
      return trimmed;
    }
  }
  return '';
}

async function computePkceCodeChallenge(codeVerifier) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(String(codeVerifier || '')),
  );
  return Buffer.from(digest)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}

function desktopAuthorizeSocialProvider(url) {
  const normalizedProvider = String(url.searchParams.get('social_provider') || '').trim().toLowerCase();
  const shouldStart = String(url.searchParams.get('social_start') || '').trim();
  if (!normalizedProvider || shouldStart !== '1') {
    return '';
  }
  return normalizedProvider;
}

function desktopAuthorizeResumeUrl(url) {
  const resumeUrl = new URL(url.toString());
  resumeUrl.searchParams.delete('social_provider');
  resumeUrl.searchParams.delete('social_start');
  resumeUrl.searchParams.delete('error');
  resumeUrl.searchParams.delete('error_description');
  return resumeUrl.toString();
}

function desktopAuthorizeErrorCallbackUrl(url) {
  const errorUrl = new URL(desktopAuthorizeResumeUrl(url));
  return errorUrl.toString();
}

function desktopAuthorizeErrorMessage(url) {
  const error = String(url.searchParams.get('error') || '').trim();
  if (!error) {
    return '';
  }
  const description = String(url.searchParams.get('error_description') || '').trim();
  if (description) {
    return `${error}: ${description}`;
  }
  return error;
}

function errorMessageFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }
  if (typeof payload.code === 'string' && payload.code.trim()) {
    return payload.code.trim();
  }
  return '';
}

function buildDesktopAuthorizeHtml({ request, allowGoogle, allowRegistration, currentUser, csrfToken, errorMessage, email }) {
  const escapedClientId = escapeHtml(request.clientId);
  const escapedRedirectUri = escapeHtml(request.redirectUri);
  const escapedState = escapeHtml(request.state);
  const escapedCodeChallenge = escapeHtml(request.codeChallenge);
  const escapedCodeChallengeMethod = escapeHtml(request.codeChallengeMethod);
  const escapedCsrfToken = escapeHtml(csrfToken);
  const escapedEmail = escapeHtml(email);
  const escapedError = escapeHtml(errorMessage);
  const currentUserName = currentUser ? escapeHtml(currentUser.name || currentUser.email || currentUser.userId) : '';
  const currentUserEmail = currentUser ? escapeHtml(currentUser.email || '') : '';
  const googleButton = allowGoogle && allowRegistration
    ? `<form method="get" action="${DESKTOP_AUTH_BASE_PATH}/authorize" class="social-form">
        <input type="hidden" name="client_id" value="${escapedClientId}" />
        <input type="hidden" name="redirect_uri" value="${escapedRedirectUri}" />
        <input type="hidden" name="state" value="${escapedState}" />
        <input type="hidden" name="code_challenge" value="${escapedCodeChallenge}" />
        <input type="hidden" name="code_challenge_method" value="${escapedCodeChallengeMethod}" />
        <input type="hidden" name="social_provider" value="google" />
        <input type="hidden" name="social_start" value="1" />
        <button type="submit" class="secondary">Continue with Google</button>
      </form>`
    : '';
  const registrationHint = allowRegistration
    ? '<p class="muted">Use your Feel8 Asset Cloud account to continue in Feel8 Studio.</p>'
    : '<p class="muted">Registration is currently disabled. Sign in with an existing account.</p>';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in to Feel8 Asset Cloud</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #0b1220;
        color: #edf2ff;
      }
      main {
        width: min(92vw, 460px);
        padding: 28px;
        border: 1px solid #30456b;
        border-radius: 16px;
        background: #111b2e;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 1.6rem;
      }
      p {
        margin: 0 0 12px;
      }
      .muted {
        color: #9fb0cc;
      }
      .error {
        margin: 16px 0;
        padding: 10px 12px;
        border-radius: 10px;
        background: rgba(239, 68, 68, 0.16);
        border: 1px solid rgba(248, 113, 113, 0.45);
        color: #fecaca;
      }
      form {
        display: grid;
        gap: 14px;
        margin-top: 18px;
      }
      .section {
        margin-top: 18px;
        padding: 14px;
        border-radius: 12px;
        border: 1px solid #30456b;
        background: rgba(12, 24, 44, 0.72);
      }
      label {
        display: grid;
        gap: 6px;
        font-size: 0.95rem;
      }
      input {
        border: 1px solid #41577f;
        border-radius: 10px;
        background: #0b1426;
        color: inherit;
        padding: 12px 14px;
        font: inherit;
      }
      button {
        border: 0;
        border-radius: 10px;
        padding: 12px 16px;
        font: inherit;
        font-weight: 600;
        background: #5aa9ff;
        color: #04111f;
        cursor: pointer;
      }
      button.secondary {
        background: #e5eefc;
        color: #0b1426;
      }
      .social-form {
        margin-top: 14px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Continue to Feel8 Studio</h1>
      <p class="muted">Sign in here and we’ll send your browser back to the running Studio session.</p>
      ${registrationHint}
      ${escapedError ? `<div class="error">${escapedError}</div>` : ''}
      ${currentUser ? `<section class="section">
        <p>Signed in as <strong>${currentUserName}</strong>${currentUserEmail ? ` <span class="muted">(${currentUserEmail})</span>` : ''}</p>
        <form method="post" action="${DESKTOP_AUTH_BASE_PATH}/authorize">
          <input type="hidden" name="client_id" value="${escapedClientId}" />
          <input type="hidden" name="redirect_uri" value="${escapedRedirectUri}" />
          <input type="hidden" name="state" value="${escapedState}" />
          <input type="hidden" name="code_challenge" value="${escapedCodeChallenge}" />
          <input type="hidden" name="code_challenge_method" value="${escapedCodeChallengeMethod}" />
          <input type="hidden" name="csrf_token" value="${escapedCsrfToken}" />
          <button type="submit">Continue as ${currentUserName}</button>
        </form>
      </section>` : ''}
      <form method="post" action="${DESKTOP_AUTH_BASE_PATH}/authorize">
        <input type="hidden" name="client_id" value="${escapedClientId}" />
        <input type="hidden" name="redirect_uri" value="${escapedRedirectUri}" />
        <input type="hidden" name="state" value="${escapedState}" />
        <input type="hidden" name="code_challenge" value="${escapedCodeChallenge}" />
        <input type="hidden" name="code_challenge_method" value="${escapedCodeChallengeMethod}" />
        <input type="hidden" name="csrf_token" value="${escapedCsrfToken}" />
        <label>
          Email
          <input type="email" name="email" value="${escapedEmail}" autocomplete="email" ${currentUser ? '' : 'required'} />
        </label>
        <label>
          Password
          <input type="password" name="password" autocomplete="current-password" ${currentUser ? '' : 'required'} />
        </label>
        <button type="submit">${currentUser ? 'Use a different account' : 'Sign in to Asset Cloud'}</button>
      </form>
      ${googleButton}
    </main>
  </body>
</html>`;
}
