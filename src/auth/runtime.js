import { betterAuth, generateId } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, captcha } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import { authSchema } from '../auth_schema.js';
import { authPasswordHashVersion, hashAuthPassword, verifyAuthPassword } from '../password.js';
import { AUTH_BASE_PATH } from '../common/paths.js';
import { USER_ROLE_ADMIN, USER_ROLE_USER, assertReservedNameAllowedForRole } from '../common/identity.js';
import { toAppUser } from './session.js';
import { buildResetPasswordUrl, buildVerifyEmailUrl, resolveAuthActionUrl, sendResetPasswordMessage, sendVerifyEmailMessage } from './mail.js';
import { HttpError, resolveAuthBaseUrl, resolveTrustedOrigins, secondsFromEnv } from '../common/http.js';
import { bytesToHex, textEncoder } from '../common/crypto.js';

const BOOTSTRAP_ADMIN_STATE_ROW_ID = 1;

let bootstrapAdminInitByDb = new WeakMap();

let authCacheByDb = new WeakMap();

export function resetAuthCaches() { bootstrapAdminInitByDb = new WeakMap(); authCacheByDb = new WeakMap(); }

function createAuth(env, { siteSettings, baseURL, trustedOrigins }) {
  const db = drizzle(env.DB);
  const socialProviders = {};
  const plugins = [
    admin({
      defaultRole: USER_ROLE_USER,
      adminRoles: [USER_ROLE_ADMIN],
    }),
  ];
  if (turnstileSecretKey(env)) {
    plugins.push(captcha({
      provider: 'cloudflare-turnstile',
      secretKey: turnstileSecretKey(env),
      endpoints: ['/sign-up/email', '/request-password-reset'],
    }));
  }
  if (hasGoogleProvider(env)) {
    socialProviders.google = {
      clientId: String(env.GOOGLE_CLIENT_ID || '').trim(),
      clientSecret: String(env.GOOGLE_CLIENT_SECRET || '').trim(),
      disableImplicitSignUp: !siteSettings.allowUserRegistration,
    };
  }

  return betterAuth({
    secret: getAuthSecret(env),
    baseURL,
    basePath: AUTH_BASE_PATH,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: authSchema,
      usePlural: false,
      transaction: false,
    }),
    databaseHooks: {
      user: {
        create: {
          async before(user) {
            assertReservedNameAllowedForRole({
              name: user?.name,
              role: user?.role,
            });
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: hashAuthPassword,
        verify: verifyAuthPassword,
      },
      resetPasswordTokenExpiresIn: secondsFromEnv(env.PASSWORD_RESET_TOKEN_TTL_SECONDS, 1800),
      sendResetPassword: async ({ user, token, url }) => {
        const appUser = toAppUser(user);
        const resetUrl = resolveAuthActionUrl({
          preferredUrl: url,
          fallbackUrl: buildResetPasswordUrl({ env, baseURL, token }),
        });
        await sendResetPasswordMessage({
          env,
          toEmail: appUser.email,
          recipientName: appUser.name || appUser.email,
          resetUrl,
        });
      },
    },
    emailVerification: {
      sendOnSignIn: true,
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: secondsFromEnv(env.EMAIL_VERIFY_TOKEN_TTL_SECONDS, 1800),
      sendVerificationEmail: async ({ user, token, url }) => {
        const appUser = toAppUser(user);
        const verificationUrl = resolveAuthActionUrl({
          preferredUrl: url,
          fallbackUrl: buildVerifyEmailUrl({ env, baseURL, token }),
        });
        await sendVerifyEmailMessage({
          env,
          toEmail: appUser.email,
          recipientName: appUser.name || appUser.email,
          verificationUrl,
        });
      },
    },
    user: {
      changeEmail: {
        enabled: true,
      },
    },
    socialProviders,
    plugins,
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 6 },
        '/sign-up/email': { window: 600, max: 5 },
        '/request-password-reset': { window: 900, max: 4 },
        '/send-verification-email': { window: 900, max: 4 },
        '/verify-email': { window: 300, max: 10 },
      },
    },
  });
}

export async function getOrCreateAuth(env, request, siteSettings = null) {
  const resolvedSiteSettings = siteSettings ?? await readSiteSettings(env.DB);
  const requestUrl = new URL(request.url);
  const baseURL = resolveAuthBaseUrl(env, requestUrl);
  const trustedOrigins = resolveTrustedOrigins(env, requestUrl, baseURL);
  const cacheKey = buildAuthCacheKey({
    allowUserRegistration: resolvedSiteSettings.allowUserRegistration,
    baseURL,
    trustedOrigins,
  });
  const dbCache = getOrCreateDbCache(authCacheByDb, env.DB);
  const cached = dbCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const auth = createAuth(env, {
    siteSettings: resolvedSiteSettings,
    baseURL,
    trustedOrigins,
  });
  dbCache.set(cacheKey, auth);
  return auth;
}

export async function ensureBootstrapAdmin({ env }) {
  const config = readBootstrapAdminConfig(env);
  if (config === null) {
    return;
  }

  const db = env?.DB;
  if (db && typeof db === 'object') {
    const pending = bootstrapAdminInitByDb.get(db);
    if (pending) {
      await pending;
      return;
    }

    const initPromise = ensureBootstrapAdminOnce(env, config);
    bootstrapAdminInitByDb.set(db, initPromise);
    try {
      await initPromise;
    } catch (error) {
      bootstrapAdminInitByDb.delete(db);
      throw error;
    }
    return;
  }

  await ensureBootstrapAdminOnce(env, config);
}

function readBootstrapAdminConfig(env) {
  const legacyUsername = String(env.BOOTSTRAP_ADMIN_USERNAME || '').trim();
  const name = String(
    env.BOOTSTRAP_ADMIN_NAME
      || env.BOOTSTRAP_ADMIN_DISPLAY_NAME
      || legacyUsername
      || 'Administrator',
  ).trim();
  const password = String(env.BOOTSTRAP_ADMIN_PASSWORD || '').trim();
  const email = String(
    env.BOOTSTRAP_ADMIN_EMAIL
      || (legacyUsername ? `${legacyUsername.toLowerCase()}@local.invalid` : ''),
  ).trim().toLowerCase();
  if (!name || !password || !email) {
    return null;
  }
  return {
    name,
    password,
    email,
  };
}

async function ensureBootstrapAdminOnce(env, config) {
  const configFingerprint = await computeBootstrapAdminFingerprint(env, config);
  const syncedState = await readBootstrapAdminState(env.DB);
  if (syncedState !== null && syncedState.configFingerprint === configFingerprint) {
    const syncedAdmin = await readBootstrapAdminCredentialAccount(env.DB, syncedState.userId);
    if (bootstrapAdminMatchesConfig(syncedAdmin, config)) {
      return;
    }
  }

  const existing = await env.DB.prepare(
    `SELECT
       u.id,
       a.id AS credential_account_id
     FROM user u
     LEFT JOIN account a
       ON a.userId = u.id AND a.providerId = 'credential'
     WHERE u.email = ? OR u.name = ?
     LIMIT 1`,
  )
    .bind(config.email, config.name)
    .first();
  const timestamp = Date.now();

  if (existing === null) {
    const passwordHash = await hashAuthPassword(config.password);
    const userId = generateId();
    await env.DB.prepare(
      `INSERT INTO user
         ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt", "role", "banned", "banReason", "banExpires")
       VALUES (?, ?, ?, 1, NULL, ?, ?, 'admin', 0, NULL, NULL)`,
    )
      .bind(userId, config.name, config.email, timestamp, timestamp)
      .run();
    await env.DB.prepare(
      `INSERT INTO account
         ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt")
       VALUES (?, ?, 'credential', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    )
      .bind(generateId(), userId, userId, passwordHash, timestamp, timestamp)
      .run();
    await upsertBootstrapAdminState(env.DB, {
      configFingerprint,
      userId,
    });
    return;
  }

  const userId = String(existing.id);
  await env.DB.prepare(
    `UPDATE user
     SET email = ?,
         role = 'admin',
         emailVerified = 1,
         name = ?,
         updatedAt = ?
     WHERE id = ?`,
  )
    .bind(config.email, config.name, timestamp, userId)
    .run();

  if (existing.credential_account_id === null || existing.credential_account_id === undefined) {
    const passwordHash = await hashAuthPassword(config.password);
    await env.DB.prepare(
      `INSERT INTO account
         ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt")
       VALUES (?, ?, 'credential', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    )
      .bind(generateId(), userId, userId, passwordHash, timestamp, timestamp)
      .run();
    await upsertBootstrapAdminState(env.DB, {
      configFingerprint,
      userId,
    });
    return;
  }

  if (syncedState === null || syncedState.configFingerprint !== configFingerprint) {
    const passwordHash = await hashAuthPassword(config.password);
    await env.DB.prepare(
      `UPDATE account
       SET accountId = ?,
           password = ?,
           updatedAt = ?
       WHERE id = ?`,
    )
      .bind(userId, passwordHash, timestamp, String(existing.credential_account_id))
      .run();
  }

  await upsertBootstrapAdminState(env.DB, {
    configFingerprint,
    userId,
  });
}

export function validateEnv(env) {
  if (!env || typeof env !== 'object' || env.DB === undefined || env.DB === null) {
    throw new HttpError(500, 'DB binding is not configured');
  }
  if (!getAuthSecret(env)) {
    throw new HttpError(500, 'BETTER_AUTH_SECRET is not configured');
  }
  if (!String(env.AUTH_BASE_URL || '').trim()) {
    throw new HttpError(500, 'AUTH_BASE_URL is not configured');
  }
}

function getAuthSecret(env) {
  return String(env.BETTER_AUTH_SECRET || '').trim();
}

export function hasGoogleProvider(env) {
  return Boolean(String(env.GOOGLE_CLIENT_ID || '').trim() && String(env.GOOGLE_CLIENT_SECRET || '').trim());
}

export function turnstileSiteKey(env) {
  const siteKey = String(
    env.TURNSTILE_SITE_KEY
      || env.CLOUDFLARE_TURNSTILE_SITE_KEY
      || '',
  ).trim();
  return siteKey || null;
}

function turnstileSecretKey(env) {
  return String(
    env.TURNSTILE_SECRET_KEY
      || env.CLOUDFLARE_TURNSTILE_SECRET_KEY
      || '',
  ).trim();
}

function getOrCreateDbCache(cacheByDb, db) {
  let cache = cacheByDb.get(db);
  if (cache !== undefined) {
    return cache;
  }
  cache = new Map();
  cacheByDb.set(db, cache);
  return cache;
}

function buildAuthCacheKey({ allowUserRegistration, baseURL, trustedOrigins }) {
  return JSON.stringify({
    allowUserRegistration: Boolean(allowUserRegistration),
    baseURL: String(baseURL || '').trim(),
    trustedOrigins: [...trustedOrigins].sort(),
  });
}

export function invalidateAuthCache(db) {
  if (db && typeof db === 'object') {
    authCacheByDb.delete(db);
  }
}

export function shouldBlockPublicRegistration({ siteSettings, request }) {
  if (!isPublicRegistrationRequest(request)) {
    return false;
  }
  return !siteSettings.allowUserRegistration;
}

function isPublicRegistrationRequest(request) {
  const url = new URL(request.url);
  if (request.method !== 'POST') {
    return false;
  }
  return url.pathname === `${AUTH_BASE_PATH}/sign-up/email`;
}

export async function readSiteSettings(db) {
  const row = await db.prepare(
    `SELECT allow_user_registration
     FROM site_settings
     WHERE id = 1`,
  ).first();
  if (row === null) {
    await db.prepare(
      `INSERT INTO site_settings (id, allow_user_registration, updated_at, updated_by_user_id)
       VALUES (1, 0, CURRENT_TIMESTAMP, NULL)
       ON CONFLICT(id) DO NOTHING`,
    ).run();
    return {
      allowUserRegistration: false,
    };
  }
  return {
    allowUserRegistration: Number(row?.allow_user_registration ?? 0) !== 0,
  };
}

async function computeBootstrapAdminFingerprint(env, config) {
  const payload = JSON.stringify({
    authSecret: getAuthSecret(env),
    passwordHashVersion: authPasswordHashVersion(),
    email: config.email,
    password: config.password,
    name: config.name,
  });
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(payload));
  return bytesToHex(new Uint8Array(digest));
}

async function readBootstrapAdminState(db) {
  const row = await db.prepare(
    `SELECT config_fingerprint, user_id
     FROM bootstrap_admin_state
     WHERE id = ?`,
  )
    .bind(BOOTSTRAP_ADMIN_STATE_ROW_ID)
    .first();
  if (row === null) {
    return null;
  }
  const configFingerprint = String(row.config_fingerprint || '').trim();
  const userId = String(row.user_id || '').trim();
  if (!configFingerprint || !userId) {
    return null;
  }
  return {
    configFingerprint,
    userId,
  };
}

async function readBootstrapAdminCredentialAccount(db, userId) {
  return db.prepare(
    `SELECT
       u.id,
       u.email,
       u.name,
       u.role,
       u.emailVerified,
       a.id AS credential_account_id
     FROM user u
     LEFT JOIN account a
       ON a.userId = u.id AND a.providerId = 'credential'
     WHERE u.id = ?
     LIMIT 1`,
  )
    .bind(String(userId))
    .first();
}

function bootstrapAdminMatchesConfig(row, config) {
  if (row === null) {
    return false;
  }
  if (row.credential_account_id === null || row.credential_account_id === undefined) {
    return false;
  }
  return (
    String(row.email || '').trim().toLowerCase() === config.email
    && String(row.name || '').trim() === config.name
    && String(row.role || '').trim() === USER_ROLE_ADMIN
    && Number(row.emailVerified || 0) !== 0
  );
}

async function upsertBootstrapAdminState(db, { configFingerprint, userId }) {
  await db.prepare(
    `INSERT INTO bootstrap_admin_state (id, config_fingerprint, user_id, synced_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       config_fingerprint = excluded.config_fingerprint,
       user_id = excluded.user_id,
       synced_at = CURRENT_TIMESTAMP`,
  )
    .bind(BOOTSTRAP_ADMIN_STATE_ROW_ID, String(configFingerprint), String(userId))
    .run();
}
