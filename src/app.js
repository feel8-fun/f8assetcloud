import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerOpenApiRoutes } from './openapi.js';
import { AssetRepository } from './repository.js';
import { registerLibraryRoutes } from './library/routes.ts';
import { AUTH_BASE_PATH, MANAGEMENT_API_BASE_PATH } from './common/paths.js';
import { DESKTOP_AUTH_BASE_PATH, resetDesktopCaches, routeDesktopAuthorizeGet, routeDesktopAuthorizePost, routeDesktopRefreshPost, routeDesktopRevokePost, routeDesktopSessionPost, routeDesktopTokenPost } from './auth/desktop.js';
import { getTypedAsset, routeAssetRequest } from './legacy/asset_routes.js';
import { routeManagementRequest } from './legacy/management_routes.js';
import { ensureBootstrapAdmin, getOrCreateAuth, hasGoogleProvider, readSiteSettings, resetAuthCaches, shouldBlockPublicRegistration, turnstileSiteKey, validateEnv } from './auth/runtime.js';
import { changeAppUserPassword, optionalAuthenticatedUser, requireAssetWriteUser, requireAuthenticatedUser, requireManagementUser, resetSessionCaches, toApiUser, updateAppUserName } from './auth/session.js';
import { HttpError, applyAnonymousPublicCacheHeaders, calculateAllowedOrigins, handleError, jsonResponse, readJsonBody, requireBodyString, requireQueryString, resolveAllowedOrigin } from './common/http.js';
import { requireUserProfileName } from './common/identity.js';
import { serveFrontend } from './frontend.js';

export function createApp() {
  const app = new Hono();

  app.use('*', async (c, next) => {
    validateEnv(c.env);
    await next();
  });

  app.use('*', cors({
    origin: (origin, c) => resolveAllowedOrigin(c.env, origin, new URL(c.req.url)),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-Captcha-Response'],
  }));

  app.all(`${AUTH_BASE_PATH}/*`, async (c) => {
    const siteSettings = await readSiteSettings(c.env.DB);
    const auth = await getOrCreateAuth(c.env, c.req.raw, siteSettings);
    await ensureBootstrapAdmin({ env: c.env });
    if (shouldBlockPublicRegistration({ siteSettings, request: c.req.raw })) {
      return jsonResponse(403, { message: 'new user registration is disabled' });
    }
    return auth.handler(c.req.raw);
  });

  app.use('/v1/*', async (c, next) => {
    const auth = await getOrCreateAuth(c.env, c.req.raw);
    await ensureBootstrapAdmin({ env: c.env });
    c.set('auth', auth);
    c.set('repo', new AssetRepository(c.env.DB));
    c.set('allowedOrigins', calculateAllowedOrigins(c.env));
    await next();
  });

  registerOpenApiRoutes(app, {
    getAuthProviders: async (c) => ({
      google: hasGoogleProvider(c.env),
      turnstileSiteKey: turnstileSiteKey(c.env),
    }),
    getSiteSettings: async (c) => c.get('repo').getSiteSettings(),
    routeDesktopTokenPost: async (c) => routeDesktopTokenPost({
      db: c.env.DB,
      request: c.req.raw,
    }),
    routeDesktopSessionPost: async (c) => routeDesktopSessionPost({
      auth: c.get('auth'),
      db: c.env.DB,
      request: c.req.raw,
      allowedOrigins: c.get('allowedOrigins'),
    }),
    routeDesktopRefreshPost: async (c) => routeDesktopRefreshPost({
      db: c.env.DB,
      request: c.req.raw,
    }),
    routeDesktopRevokePost: async (c) => routeDesktopRevokePost({
      db: c.env.DB,
      request: c.req.raw,
    }),
    resolveAsset: async (c) => {
      const auth = c.get('auth');
      const repo = c.get('repo');
      const viewer = await optionalAuthenticatedUser({ auth, db: c.env.DB, request: c.req.raw });
      const viewerId = viewer === null ? null : viewer.userId;
      const assetId = c.req.param('assetId');
      const head = await repo.getAssetById(assetId);
      if (head === null) {
        throw new HttpError(404, 'not found');
      }
      if (String(head.visibility) !== 'public' && String(head.owner_user_id) !== String(viewerId || '')) {
        throw new HttpError(404, 'not found');
      }
      const assetType = String(head.asset_type);
      const asset = await getTypedAsset({ repo, assetType, assetId, userId: viewerId, head });
      applyAnonymousPublicCacheHeaders(c, c.req.raw, String(head.visibility) === 'public' && viewer === null);
      return { assetType, asset };
    },
    getMe: async (c) => {
      const user = await requireAuthenticatedUser({
        auth: c.get('auth'),
        db: c.env.DB,
        request: c.req.raw,
        allowedOrigins: c.get('allowedOrigins'),
      });
      return toApiUser(user);
    },
    updateMe: async (c) => {
      const repo = c.get('repo');
      const user = await requireAuthenticatedUser({
        auth: c.get('auth'),
        db: c.env.DB,
        request: c.req.raw,
        allowedOrigins: c.get('allowedOrigins'),
      });
      const payload = await readJsonBody(c.req.raw);
      const name = requireUserProfileName(payload.name, {
        currentName: user.name,
        allowReserved: user.isAdmin,
      });
      if (name !== user.name) {
        if (await repo.isUserNameTaken({ name, excludeUserId: user.userId })) {
          throw new HttpError(409, 'name already in use');
        }
        await updateAppUserName(c.env.DB, {
          userId: user.userId,
          name,
        });
      }
      const updated = await repo.getUserByIdWithStats(user.userId);
      if (updated === null) {
        throw new HttpError(404, 'user not found');
      }
      return toApiUser(updated);
    },
    listComponents: async (c) => {
      const viewer = await optionalAuthenticatedUser({ auth: c.get('auth'), db: c.env.DB, request: c.req.raw });
      applyAnonymousPublicCacheHeaders(c, c.req.raw, viewer === null);
      return c.get('repo').listComponents({
        userId: viewer === null ? null : viewer.userId,
        query: c.req.query('q') || '',
        visibility: c.req.query('visibility') || '',
        owner: c.req.query('owner') || '',
        cursor: c.req.query('cursor') || '',
      });
    },
    getComponentContent: async (c) => {
      const viewer = await optionalAuthenticatedUser({ auth: c.get('auth'), db: c.env.DB, request: c.req.raw });
      const result = await c.get('repo').getComponentContent({
        componentId: c.req.param('componentId'),
        userId: viewer === null ? null : viewer.userId,
      });
      applyAnonymousPublicCacheHeaders(c, c.req.raw, viewer === null);
      return result;
    },
    listVariants: async (c) => {
      const viewer = await optionalAuthenticatedUser({ auth: c.get('auth'), db: c.env.DB, request: c.req.raw });
      applyAnonymousPublicCacheHeaders(c, c.req.raw, viewer === null);
      return c.get('repo').listVariants({
        userId: viewer === null ? null : viewer.userId,
        kind: c.req.query('kind') || '',
        baseNodeType: c.req.query('baseNodeType') || '',
        query: c.req.query('q') || '',
        visibility: c.req.query('visibility') || '',
        owner: c.req.query('owner') || '',
        cursor: c.req.query('cursor') || '',
      });
    },
    createVariant: async (c) => {
      const repo = c.get('repo');
      const user = await requireAssetWriteUser({
        auth: c.get('auth'),
        db: c.env.DB,
        repo,
        request: c.req.raw,
        allowedOrigins: c.get('allowedOrigins'),
      });
      const payload = await readJsonBody(c.req.raw);
      return repo.createVariant({ payload, user });
    },
    createComponent: async (c) => {
      const repo = c.get('repo');
      const user = await requireAssetWriteUser({
        auth: c.get('auth'),
        db: c.env.DB,
        repo,
        request: c.req.raw,
        allowedOrigins: c.get('allowedOrigins'),
      });
      const payload = await readJsonBody(c.req.raw);
      return repo.createComponent({ payload, user });
    },
    listModdingRecipes: async (c) => {
      const viewer = await optionalAuthenticatedUser({ auth: c.get('auth'), db: c.env.DB, request: c.req.raw });
      applyAnonymousPublicCacheHeaders(c, c.req.raw, viewer === null);
      return c.get('repo').listModdingRecipes({
        userId: viewer === null ? null : viewer.userId,
        query: c.req.query('q') || '',
        visibility: c.req.query('visibility') || '',
        owner: c.req.query('owner') || '',
        cursor: c.req.query('cursor') || '',
      });
    },
    createModdingRecipe: async (c) => {
      const repo = c.get('repo');
      const user = await requireAssetWriteUser({
        auth: c.get('auth'),
        db: c.env.DB,
        repo,
        request: c.req.raw,
        allowedOrigins: c.get('allowedOrigins'),
      });
      const payload = await readJsonBody(c.req.raw);
      return repo.createModdingRecipe({ payload, user });
    },
    routeVariantAssetRequest: async (c) => routeAssetRequest({
      auth: c.get('auth'),
      db: c.env.DB,
      repo: c.get('repo'),
      request: c.req.raw,
      url: new URL(c.req.raw.url),
      assetType: 'variant',
      allowedOrigins: c.get('allowedOrigins'),
    }),
    routeComponentAssetRequest: async (c) => routeAssetRequest({
      auth: c.get('auth'),
      db: c.env.DB,
      repo: c.get('repo'),
      request: c.req.raw,
      url: new URL(c.req.raw.url),
      assetType: 'component',
      allowedOrigins: c.get('allowedOrigins'),
    }),
    routeModdingRecipeAssetRequest: async (c) => routeAssetRequest({
      auth: c.get('auth'),
      db: c.env.DB,
      repo: c.get('repo'),
      request: c.req.raw,
      url: new URL(c.req.raw.url),
      assetType: 'modding_recipe',
      allowedOrigins: c.get('allowedOrigins'),
    }),
    routeManagementRequest: async (c) => {
      const managementUser = await requireManagementUser({
        auth: c.get('auth'),
        db: c.env.DB,
        request: c.req.raw,
        allowedOrigins: c.get('allowedOrigins'),
      });
      return routeManagementRequest({
        db: c.env.DB,
        env: c.env,
        managementUser,
        auth: c.get('auth'),
        repo: c.get('repo'),
        request: c.req.raw,
        url: new URL(c.req.raw.url),
        allowedOrigins: c.get('allowedOrigins'),
      });
    },
  });

  app.get('/v1/auth/verify-email', async (c) => {
    const auth = c.get('auth');
    const token = requireQueryString(c.req.query('token'), 'token is required');
    await auth.api.verifyEmail({
      query: { token },
      headers: c.req.raw.headers,
    });
    return c.json({ verified: true });
  });

  app.post('/v1/auth/reset-password', async (c) => {
    const auth = c.get('auth');
    const payload = await readJsonBody(c.req.raw);
    await auth.api.resetPassword({
      body: {
        token: requireBodyString(payload.token, 'token is required'),
        newPassword: requireBodyString(payload.newPassword, 'newPassword is required'),
      },
      headers: c.req.raw.headers,
    });
    return c.json({ reset: true });
  });

  app.get(`${DESKTOP_AUTH_BASE_PATH}/authorize`, async (c) => {
    const auth = c.get('auth');
    const siteSettings = await c.get('repo').getSiteSettings();
    return routeDesktopAuthorizeGet({
      auth,
      db: c.env.DB,
      env: c.env,
      request: c.req.raw,
      siteSettings,
    });
  });

  app.post(`${DESKTOP_AUTH_BASE_PATH}/authorize`, async (c) => {
    const auth = c.get('auth');
    const siteSettings = await c.get('repo').getSiteSettings();
    return routeDesktopAuthorizePost({
      auth,
      db: c.env.DB,
      env: c.env,
      request: c.req.raw,
      siteSettings,
    });
  });

  app.post(`${DESKTOP_AUTH_BASE_PATH}/token`, async (c) => {
    return routeDesktopTokenPost({
      db: c.env.DB,
      request: c.req.raw,
    });
  });

  app.post(`${DESKTOP_AUTH_BASE_PATH}/session`, async (c) => routeDesktopSessionPost({
    auth: c.get('auth'),
    db: c.env.DB,
    request: c.req.raw,
    allowedOrigins: c.get('allowedOrigins'),
  }));

  app.post(`${DESKTOP_AUTH_BASE_PATH}/refresh`, async (c) => routeDesktopRefreshPost({
    db: c.env.DB,
    request: c.req.raw,
  }));

  app.post(`${DESKTOP_AUTH_BASE_PATH}/revoke`, async (c) => routeDesktopRevokePost({
    db: c.env.DB,
    request: c.req.raw,
  }));

  app.post('/v1/me/password', async (c) => {
    const user = await requireAuthenticatedUser({
      auth: c.get('auth'),
      db: c.env.DB,
      request: c.req.raw,
      allowedOrigins: c.get('allowedOrigins'),
    });
    const payload = await readJsonBody(c.req.raw);
    await changeAppUserPassword(c.env.DB, {
      userId: user.userId,
      currentPassword: requireBodyString(payload.currentPassword, 'currentPassword is required'),
      newPassword: requireBodyString(payload.newPassword, 'newPassword is required'),
    });
    return c.json({});
  });

  app.get('/v1/variants', async (c) => {
    const repo = c.get('repo');
    const viewer = await optionalAuthenticatedUser({ auth: c.get('auth'), db: c.env.DB, request: c.req.raw });
    applyAnonymousPublicCacheHeaders(c, c.req.raw, viewer === null);
    const result = await repo.listVariants({
      userId: viewer === null ? null : viewer.userId,
      kind: c.req.query('kind') || '',
      baseNodeType: c.req.query('baseNodeType') || '',
      query: c.req.query('q') || '',
      visibility: c.req.query('visibility') || '',
      owner: c.req.query('owner') || '',
      cursor: c.req.query('cursor') || '',
    });
    return c.json(result);
  });

  app.post('/v1/variants', async (c) => {
    const repo = c.get('repo');
    const user = await requireAssetWriteUser({
      auth: c.get('auth'),
      db: c.env.DB,
      repo,
      request: c.req.raw,
      allowedOrigins: c.get('allowedOrigins'),
    });
    const payload = await readJsonBody(c.req.raw);
    return c.json(await repo.createVariant({ payload, user }));
  });

  app.post('/v1/components', async (c) => {
    const repo = c.get('repo');
    const user = await requireAssetWriteUser({
      auth: c.get('auth'),
      db: c.env.DB,
      repo,
      request: c.req.raw,
      allowedOrigins: c.get('allowedOrigins'),
    });
    const payload = await readJsonBody(c.req.raw);
    return c.json(await repo.createComponent({ payload, user }));
  });

  app.get('/v1/modding-recipes', async (c) => {
    const repo = c.get('repo');
    const viewer = await optionalAuthenticatedUser({ auth: c.get('auth'), db: c.env.DB, request: c.req.raw });
    applyAnonymousPublicCacheHeaders(c, c.req.raw, viewer === null);
    const result = await repo.listModdingRecipes({
      userId: viewer === null ? null : viewer.userId,
      query: c.req.query('q') || '',
      visibility: c.req.query('visibility') || '',
      owner: c.req.query('owner') || '',
      cursor: c.req.query('cursor') || '',
    });
    return c.json(result);
  });

  app.post('/v1/modding-recipes', async (c) => {
    const repo = c.get('repo');
    const user = await requireAssetWriteUser({
      auth: c.get('auth'),
      db: c.env.DB,
      repo,
      request: c.req.raw,
      allowedOrigins: c.get('allowedOrigins'),
    });
    const payload = await readJsonBody(c.req.raw);
    return c.json(await repo.createModdingRecipe({ payload, user }));
  });

  app.all('/v1/variants/*', async (c) => routeAssetRequest({
    auth: c.get('auth'),
    db: c.env.DB,
    repo: c.get('repo'),
    request: c.req.raw,
    url: new URL(c.req.raw.url),
    assetType: 'variant',
    allowedOrigins: c.get('allowedOrigins'),
  }));

  app.all('/v1/components/*', async (c) => routeAssetRequest({
    auth: c.get('auth'),
    db: c.env.DB,
    repo: c.get('repo'),
    request: c.req.raw,
    url: new URL(c.req.raw.url),
    assetType: 'component',
    allowedOrigins: c.get('allowedOrigins'),
  }));

  app.all('/v1/modding-recipes/*', async (c) => routeAssetRequest({
    auth: c.get('auth'),
    db: c.env.DB,
    repo: c.get('repo'),
    request: c.req.raw,
    url: new URL(c.req.raw.url),
    assetType: 'modding_recipe',
    allowedOrigins: c.get('allowedOrigins'),
  }));

  app.all(`${MANAGEMENT_API_BASE_PATH}/*`, async (c) => {
    const managementUser = await requireManagementUser({
      auth: c.get('auth'),
      db: c.env.DB,
      request: c.req.raw,
      allowedOrigins: c.get('allowedOrigins'),
    });
    return routeManagementRequest({
      db: c.env.DB,
      env: c.env,
      managementUser,
      auth: c.get('auth'),
      repo: c.get('repo'),
      request: c.req.raw,
      url: new URL(c.req.raw.url),
      allowedOrigins: c.get('allowedOrigins'),
    });
  });

  registerLibraryRoutes(app, {
    viewer: async (c) => optionalAuthenticatedUser({ auth: await getOrCreateAuth(c.env,c.req.raw), db:c.env.DB, request:c.req.raw }),
    member: async (c) => requireAuthenticatedUser({ auth: await getOrCreateAuth(c.env,c.req.raw), db:c.env.DB, request:c.req.raw, allowedOrigins:calculateAllowedOrigins(c.env) }),
    writer: async (c) => requireAssetWriteUser({ auth: await getOrCreateAuth(c.env,c.req.raw), db:c.env.DB, repo:new AssetRepository(c.env.DB), request:c.req.raw, allowedOrigins:calculateAllowedOrigins(c.env) }),
    readJson: readJsonBody,
  });
  app.on(['GET', 'HEAD'], '*', async (c) => serveFrontend(c.req.raw, c.env, new URL(c.req.raw.url)));

  app.all('*', () => jsonResponse(404, { message: 'not found' }));
  app.onError((error) => handleError(error));

  return app;
}

export function resetWorkerCachesForTesting() { resetAuthCaches(); resetDesktopCaches(); resetSessionCaches(); }
