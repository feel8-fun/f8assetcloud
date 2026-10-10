import { MANAGEMENT_API_BASE_PATH } from '../common/paths.js';
import { USER_ROLE_ADMIN, normalizeManagedUserRolePayload, requireUserProfileName } from '../common/identity.js';
import { buildWorkerRateLimitKey, enforceWorkerRateLimit, toApiUser, toAppUser } from '../auth/session.js';
import { HttpError, decodeSinglePathValue, isStateChangingRequestMethod, jsonResponse, readJsonBody, requireBodyString } from '../common/http.js';
import { invalidateAuthCache } from '../auth/runtime.js';

const PURGE_ALL_ASSETS_CONFIRMATION_TEXT = 'DELETE ALL ASSETS';

export async function routeManagementRequest({ db, env, managementUser, auth, repo, request, url, allowedOrigins }) {
  if (isStateChangingRequestMethod(request.method)) {
    await enforceWorkerRateLimit({
      db,
      key: buildWorkerRateLimitKey({
        namespace: `management_${String(request.method).toLowerCase()}`,
        request,
      }),
      windowSeconds: 60,
      maxRequests: 20,
    });
  }
  if (request.method === 'GET' && url.pathname === `${MANAGEMENT_API_BASE_PATH}/users`) {
    const users = await repo.listUsers({
      query: url.searchParams.get('q') || '',
      cursor: url.searchParams.get('cursor') || '',
    });
    return jsonResponse(200, users);
  }

  if (request.method === 'POST' && url.pathname === `${MANAGEMENT_API_BASE_PATH}/users`) {
    const payload = await readJsonBody(request);
    const role = normalizeManagedUserRolePayload(payload);
    const name = requireUserProfileName(payload.name, {
      allowReserved: role === USER_ROLE_ADMIN,
    });
    const created = await auth.api.createUser({
      body: {
        email: requireBodyString(payload.email, 'email is required'),
        password: requireBodyString(payload.password, 'password is required'),
        name,
        role,
      },
      headers: request.headers,
    });
    const user = await repo.getUserByIdWithStats(String(created.user.id));
    return jsonResponse(200, user ?? toApiUser(toAppUser(created.user)));
  }

  if (request.method === 'GET' && url.pathname === `${MANAGEMENT_API_BASE_PATH}/site-settings`) {
    return jsonResponse(200, await repo.getSiteSettings());
  }

  if (request.method === 'GET' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/users/`)) {
    const parts = parseManagementUserPath(url.pathname);
    const userId = parts.userId;
    if (!userId) {
      return jsonResponse(404, { message: 'not found' });
    }
    if (parts.suffix.length === 0) {
      const user = await repo.getUserByIdWithStats(userId);
      if (user === null) {
        return jsonResponse(404, { message: 'user not found' });
      }
      return jsonResponse(200, user);
    }
  }

  if (request.method === 'PUT' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/users/`)) {
    const parts = parseManagementUserPath(url.pathname);
    if (!parts.userId || parts.suffix.length !== 0) {
      return jsonResponse(404, { message: 'not found' });
    }
    const currentTargetUser = await repo.getUserByIdWithStats(parts.userId);
    if (currentTargetUser === null) {
      return jsonResponse(404, { message: 'user not found' });
    }
    const payload = await readJsonBody(request);
    const data = {};
    const requestedRole = payload.role !== undefined || payload.isAdmin !== undefined || payload.canUpload !== undefined
      ? normalizeManagedUserRolePayload(payload)
      : currentTargetUser.role;
    if (payload.name !== undefined) {
      data.name = requireUserProfileName(payload.name, {
        currentName: currentTargetUser.name,
        allowReserved: requestedRole === USER_ROLE_ADMIN,
      });
    }
    if (Object.keys(data).length > 0) {
      await auth.api.adminUpdateUser({
        body: {
          userId: parts.userId,
          data,
        },
        headers: request.headers,
      });
    }
    if (payload.role !== undefined || payload.isAdmin !== undefined || payload.canUpload !== undefined) {
      if (parts.userId === managementUser.userId && requestedRole !== USER_ROLE_ADMIN) {
        throw new HttpError(400, 'management user cannot remove own admin role');
      }
      await auth.api.setRole({
        body: {
          userId: parts.userId,
          role: requestedRole,
        },
        headers: request.headers,
      });
    }
    if (payload.password !== undefined) {
      await auth.api.setUserPassword({
        body: {
          userId: parts.userId,
          newPassword: requireBodyString(payload.password, 'password is required'),
        },
        headers: request.headers,
      });
    }
    const updated = await repo.getUserByIdWithStats(parts.userId);
    if (updated === null) {
      return jsonResponse(404, { message: 'user not found' });
    }
    return jsonResponse(200, updated);
  }

  if (request.method === 'PUT' && url.pathname === `${MANAGEMENT_API_BASE_PATH}/site-settings`) {
    const payload = await readJsonBody(request);
    const updated = await repo.updateSiteSettings({
      allowUserRegistration: payload.allowUserRegistration,
      updatedByUserId: managementUser.userId,
    });
    invalidateAuthCache(env?.DB);
    return jsonResponse(200, updated);
  }

  if (request.method === 'POST' && url.pathname === `${MANAGEMENT_API_BASE_PATH}/assets/purge-all`) {
    const payload = await readJsonBody(request);
    const confirmationText = requireBodyString(payload.confirmationText, 'confirmationText is required');
    if (confirmationText !== PURGE_ALL_ASSETS_CONFIRMATION_TEXT) {
      throw new HttpError(400, `confirmationText must equal ${PURGE_ALL_ASSETS_CONFIRMATION_TEXT}`);
    }
    return jsonResponse(200, await repo.adminPurgeAllAssets());
  }

  if (request.method === 'DELETE' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/users/`)) {
    const parts = parseManagementUserPath(url.pathname);
    if (!parts.userId || parts.suffix.length !== 0) {
      return jsonResponse(404, { message: 'not found' });
    }
    if (parts.userId === managementUser.userId) {
      throw new HttpError(400, 'management user cannot delete self');
    }
    await assertUserHasNoAssets(repo, parts.userId);
    await auth.api.removeUser({
      body: { userId: parts.userId },
      headers: request.headers,
    });
    return jsonResponse(200, {});
  }

  if (request.method === 'GET' && url.pathname === `${MANAGEMENT_API_BASE_PATH}/components`) {
    const result = await repo.listManagedAssets({
      assetType: 'component',
      ownerUserId: url.searchParams.get('ownerUserId') || '',
      query: url.searchParams.get('q') || '',
      cursor: url.searchParams.get('cursor') || '',
    });
    return jsonResponse(200, result);
  }

  if (request.method === 'GET' && url.pathname === `${MANAGEMENT_API_BASE_PATH}/variants`) {
    const result = await repo.listManagedAssets({
      assetType: 'variant',
      ownerUserId: url.searchParams.get('ownerUserId') || '',
      query: url.searchParams.get('q') || '',
      cursor: url.searchParams.get('cursor') || '',
      kind: url.searchParams.get('kind') || '',
      baseNodeType: url.searchParams.get('baseNodeType') || '',
    });
    return jsonResponse(200, result);
  }

  if (request.method === 'GET' && url.pathname === `${MANAGEMENT_API_BASE_PATH}/modding-recipes`) {
    const result = await repo.listManagedAssets({
      assetType: 'modding_recipe',
      ownerUserId: url.searchParams.get('ownerUserId') || '',
      query: url.searchParams.get('q') || '',
      cursor: url.searchParams.get('cursor') || '',
    });
    return jsonResponse(200, result);
  }

  if (request.method === 'GET' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/components/`)) {
    const componentId = decodeSinglePathValue(url.pathname, `${MANAGEMENT_API_BASE_PATH}/components/`);
    if (!componentId) {
      return jsonResponse(404, { message: 'not found' });
    }
    const asset = await repo.getManagedAsset({
      assetId: componentId,
      assetTypeHint: 'component',
    });
    if (asset === null) {
      return jsonResponse(404, { message: 'asset not found' });
    }
    return jsonResponse(200, asset);
  }

  if (request.method === 'GET' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/variants/`)) {
    const variantId = decodeSinglePathValue(url.pathname, `${MANAGEMENT_API_BASE_PATH}/variants/`);
    if (!variantId) {
      return jsonResponse(404, { message: 'not found' });
    }
    const asset = await repo.getManagedAsset({
      assetId: variantId,
      assetTypeHint: 'variant',
    });
    if (asset === null) {
      return jsonResponse(404, { message: 'asset not found' });
    }
    return jsonResponse(200, asset);
  }

  if (request.method === 'GET' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/modding-recipes/`)) {
    const recipeId = decodeSinglePathValue(url.pathname, `${MANAGEMENT_API_BASE_PATH}/modding-recipes/`);
    if (!recipeId) {
      return jsonResponse(404, { message: 'not found' });
    }
    const asset = await repo.getManagedAsset({
      assetId: recipeId,
      assetTypeHint: 'modding_recipe',
    });
    if (asset === null) {
      return jsonResponse(404, { message: 'asset not found' });
    }
    return jsonResponse(200, asset);
  }

  if (request.method === 'PUT' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/components/`)) {
    const componentId = decodeSinglePathValue(url.pathname, `${MANAGEMENT_API_BASE_PATH}/components/`);
    if (!componentId) {
      return jsonResponse(404, { message: 'not found' });
    }
    const payload = await readJsonBody(request);
    if (payload.visibility !== undefined) {
      const updated = await repo.adminUpdateAssetVisibility({
        assetId: componentId,
        visibility: payload.visibility,
        assetTypeHint: 'component',
      });
      if (updated === null) {
        return jsonResponse(404, { message: 'asset not found' });
      }
      return jsonResponse(200, updated);
    }
    const current = await repo.getManagedAsset({ assetId: componentId, assetTypeHint: 'component' });
    if (current === null) {
      return jsonResponse(404, { message: 'asset not found' });
    }
    return jsonResponse(200, current);
  }

  if (request.method === 'PUT' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/variants/`)) {
    const variantId = decodeSinglePathValue(url.pathname, `${MANAGEMENT_API_BASE_PATH}/variants/`);
    if (!variantId) {
      return jsonResponse(404, { message: 'not found' });
    }
    const payload = await readJsonBody(request);
    if (payload.visibility !== undefined) {
      const updated = await repo.adminUpdateAssetVisibility({
        assetId: variantId,
        visibility: payload.visibility,
        assetTypeHint: 'variant',
      });
      if (updated === null) {
        return jsonResponse(404, { message: 'asset not found' });
      }
      return jsonResponse(200, updated);
    }
    const current = await repo.getManagedAsset({ assetId: variantId, assetTypeHint: 'variant' });
    if (current === null) {
      return jsonResponse(404, { message: 'asset not found' });
    }
    return jsonResponse(200, current);
  }

  if (request.method === 'PUT' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/modding-recipes/`)) {
    const recipeId = decodeSinglePathValue(url.pathname, `${MANAGEMENT_API_BASE_PATH}/modding-recipes/`);
    if (!recipeId) {
      return jsonResponse(404, { message: 'not found' });
    }
    const payload = await readJsonBody(request);
    if (payload.visibility !== undefined) {
      const updated = await repo.adminUpdateAssetVisibility({
        assetId: recipeId,
        visibility: payload.visibility,
        assetTypeHint: 'modding_recipe',
      });
      if (updated === null) {
        return jsonResponse(404, { message: 'asset not found' });
      }
      return jsonResponse(200, updated);
    }
    const current = await repo.getManagedAsset({ assetId: recipeId, assetTypeHint: 'modding_recipe' });
    if (current === null) {
      return jsonResponse(404, { message: 'asset not found' });
    }
    return jsonResponse(200, current);
  }

  if (request.method === 'DELETE' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/components/`)) {
    const componentId = decodeSinglePathValue(url.pathname, `${MANAGEMENT_API_BASE_PATH}/components/`);
    if (!componentId) {
      return jsonResponse(404, { message: 'not found' });
    }
    const deleted = await repo.adminDeleteAsset({ assetId: componentId, assetTypeHint: 'component' });
    if (!deleted) {
      return jsonResponse(404, { message: 'asset not found' });
    }
    return jsonResponse(200, {});
  }

  if (request.method === 'DELETE' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/variants/`)) {
    const variantId = decodeSinglePathValue(url.pathname, `${MANAGEMENT_API_BASE_PATH}/variants/`);
    if (!variantId) {
      return jsonResponse(404, { message: 'not found' });
    }
    const deleted = await repo.adminDeleteAsset({ assetId: variantId, assetTypeHint: 'variant' });
    if (!deleted) {
      return jsonResponse(404, { message: 'asset not found' });
    }
    return jsonResponse(200, {});
  }

  if (request.method === 'DELETE' && url.pathname.startsWith(`${MANAGEMENT_API_BASE_PATH}/modding-recipes/`)) {
    const recipeId = decodeSinglePathValue(url.pathname, `${MANAGEMENT_API_BASE_PATH}/modding-recipes/`);
    if (!recipeId) {
      return jsonResponse(404, { message: 'not found' });
    }
    const deleted = await repo.adminDeleteAsset({ assetId: recipeId, assetTypeHint: 'modding_recipe' });
    if (!deleted) {
      return jsonResponse(404, { message: 'asset not found' });
    }
    return jsonResponse(200, {});
  }

  return jsonResponse(404, { message: 'not found' });
}

async function assertUserHasNoAssets(repo, userId) {
  const ownsAssets = await repo.hasAssets(userId);
  if (ownsAssets) {
    throw new HttpError(409, 'cannot delete user with existing assets');
  }
}

function parseManagementUserPath(pathname) {
  const prefix = `${MANAGEMENT_API_BASE_PATH}/users/`;
  const tail = decodeURIComponent(pathname.slice(prefix.length));
  const parts = tail.split('/').filter((part) => part.length > 0);
  return {
    userId: parts[0] || '',
    suffix: parts.slice(1),
  };
}
