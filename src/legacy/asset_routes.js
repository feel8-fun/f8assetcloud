import { HttpError, anonymousPublicResponseHeaders, assetDownloadResponse, isStateChangingRequestMethod, jsonResponse, readJsonBody, requireBodyString } from '../common/http.js';
import { buildWorkerRateLimitKey, enforceWorkerRateLimit, optionalAuthenticatedUser, requireAssetWriteUser, requireAuthenticatedUser } from '../auth/session.js';

function assetRouteConfig(assetType) {
  if (assetType === 'variant') {
    return {
      prefix: '/v1/variants/',
      get: ({ repo, assetId, userId, head = null }) => repo.getVariant({ variantId: assetId, userId, head }),
      update: ({ repo, assetId, payload, user }) => repo.updateVariant({ variantId: assetId, payload, user }),
      delete: ({ repo, assetId, userId }) => repo.deleteVariant({ variantId: assetId, userId }),
      getContent: ({ repo, assetId, userId, head = null }) => repo.getVariantContent({ variantId: assetId, userId, head }),
      updateVisibility: ({ repo, assetId, visibility, versionNumber, userId }) => repo.updateVariantVisibility({ variantId: assetId, visibility, versionNumber, userId }),
      updateMeta: ({ repo, assetId, payload, user }) => repo.updateVariantMeta({ variantId: assetId, payload, user }),
      listVersions: ({ repo, assetId, userId }) => repo.listVariantVersions({ variantId: assetId, userId }),
      getVersion: ({ repo, assetId, versionNumber, userId, head = null }) => repo.getVariantVersion({ variantId: assetId, versionNumber, userId, head }),
      updateVersionNote: ({ repo, assetId, versionNumber, changeSummary, userId }) => repo.updateVariantVersionNote({ variantId: assetId, versionNumber, changeSummary, userId }),
      getVersionContent: ({ repo, assetId, versionNumber, userId, head = null }) => repo.getVariantVersionContent({ variantId: assetId, versionNumber, userId, head }),
      listSubscribers: ({ repo, assetId, userId }) => repo.listVariantSubscribers({ variantId: assetId, userId }),
      subscribe: ({ repo, assetId, userId }) => repo.subscribeVariant({ variantId: assetId, userId }),
      unsubscribe: ({ repo, assetId, userId }) => repo.unsubscribeVariant({ variantId: assetId, userId }),
      fork: ({ repo, assetId, payload, user }) => repo.forkVariant({ variantId: assetId, payload, user }),
    };
  }
  if (assetType === 'component') {
    return {
      prefix: '/v1/components/',
      get: ({ repo, assetId, userId, head = null }) => repo.getComponent({ componentId: assetId, userId, head }),
      update: ({ repo, assetId, payload, user }) => repo.updateComponent({ componentId: assetId, payload, user }),
      delete: ({ repo, assetId, userId }) => repo.deleteComponent({ componentId: assetId, userId }),
      getContent: ({ repo, assetId, userId, head = null }) => repo.getComponentContent({ componentId: assetId, userId, head }),
      updateVisibility: ({ repo, assetId, visibility, versionNumber, userId }) => repo.updateComponentVisibility({ componentId: assetId, visibility, versionNumber, userId }),
      updateMeta: ({ repo, assetId, payload, user }) => repo.updateComponentMeta({ componentId: assetId, payload, user }),
      listVersions: ({ repo, assetId, userId }) => repo.listComponentVersions({ componentId: assetId, userId }),
      getVersion: ({ repo, assetId, versionNumber, userId, head = null }) => repo.getComponentVersion({ componentId: assetId, versionNumber, userId, head }),
      updateVersionNote: ({ repo, assetId, versionNumber, changeSummary, userId }) => repo.updateComponentVersionNote({ componentId: assetId, versionNumber, changeSummary, userId }),
      getVersionContent: ({ repo, assetId, versionNumber, userId, head = null }) => repo.getComponentVersionContent({ componentId: assetId, versionNumber, userId, head }),
      listSubscribers: ({ repo, assetId, userId }) => repo.listComponentSubscribers({ componentId: assetId, userId }),
      subscribe: ({ repo, assetId, userId }) => repo.subscribeComponent({ componentId: assetId, userId }),
      unsubscribe: ({ repo, assetId, userId }) => repo.unsubscribeComponent({ componentId: assetId, userId }),
      fork: ({ repo, assetId, payload, user }) => repo.forkComponent({ componentId: assetId, payload, user }),
    };
  }
  if (assetType === 'modding_recipe') {
    return {
      prefix: '/v1/modding-recipes/',
      get: ({ repo, assetId, userId, head = null }) => repo.getModdingRecipe({ recipeId: assetId, userId, head }),
      update: ({ repo, assetId, payload, user }) => repo.updateModdingRecipe({ recipeId: assetId, payload, user }),
      delete: ({ repo, assetId, userId }) => repo.deleteModdingRecipe({ recipeId: assetId, userId }),
      getContent: ({ repo, assetId, userId, head = null }) => repo.getModdingRecipeContent({ recipeId: assetId, userId, head }),
      updateVisibility: ({ repo, assetId, visibility, versionNumber, userId }) => repo.updateModdingRecipeVisibility({ recipeId: assetId, visibility, versionNumber, userId }),
      updateMeta: ({ repo, assetId, payload, user }) => repo.updateModdingRecipeMeta({ recipeId: assetId, payload, user }),
      listVersions: ({ repo, assetId, userId }) => repo.listModdingRecipeVersions({ recipeId: assetId, userId }),
      getVersion: ({ repo, assetId, versionNumber, userId, head = null }) => repo.getModdingRecipeVersion({ recipeId: assetId, versionNumber, userId, head }),
      updateVersionNote: ({ repo, assetId, versionNumber, changeSummary, userId }) => repo.updateModdingRecipeVersionNote({ recipeId: assetId, versionNumber, changeSummary, userId }),
      getVersionContent: ({ repo, assetId, versionNumber, userId, head = null }) => repo.getModdingRecipeVersionContent({ recipeId: assetId, versionNumber, userId, head }),
      listSubscribers: ({ repo, assetId, userId }) => repo.listModdingRecipeSubscribers({ recipeId: assetId, userId }),
      subscribe: ({ repo, assetId, userId }) => repo.subscribeModdingRecipe({ recipeId: assetId, userId }),
      unsubscribe: ({ repo, assetId, userId }) => repo.unsubscribeModdingRecipe({ recipeId: assetId, userId }),
      fork: ({ repo, assetId, payload, user }) => repo.forkModdingRecipe({ recipeId: assetId, payload, user }),
    };
  }
  throw new HttpError(404, 'not found');
}

export function getTypedAsset({ repo, assetType, assetId, userId, head = null }) {
  return assetRouteConfig(assetType).get({ repo, assetId, userId, head });
}

export async function routeAssetRequest({ auth, db, repo, request, url, assetType, allowedOrigins }) {
  const assetConfig = assetRouteConfig(assetType);
  const prefix = assetConfig.prefix;
  const tail = decodeURIComponent(url.pathname.slice(prefix.length));
  const parts = tail.split('/').filter((part) => part.length > 0);
  const assetId = parts[0] || '';
  if (!assetId) {
    return jsonResponse(404, { message: 'not found' });
  }
  if (isStateChangingRequestMethod(request.method)) {
    await enforceWorkerRateLimit({
      db,
      key: buildWorkerRateLimitKey({
        namespace: `${assetType}_${parts[1] || 'root'}_${String(request.method).toLowerCase()}`,
        request,
      }),
      windowSeconds: 60,
      maxRequests: parts[1] === 'subscribe' ? 20 : 30,
    });
  }

  if (parts.length === 1) {
    if (request.method === 'GET') {
      const viewer = await optionalAuthenticatedUser({ auth, db, request });
      const result = await assetConfig.get({ repo, assetId, userId: viewer === null ? null : viewer.userId });
      return jsonResponse(200, result, anonymousPublicResponseHeaders(request, viewer === null && String(result.visibility) === 'public'));
    }
    if (request.method === 'PUT') {
      const user = await requireAssetWriteUser({ auth, db, repo, request, allowedOrigins });
      const payload = await readJsonBody(request);
      const result = await assetConfig.update({ repo, assetId, payload, user });
      return jsonResponse(200, result);
    }
    if (request.method === 'DELETE') {
      const user = await requireAssetWriteUser({ auth, db, repo, request, allowedOrigins });
      await assetConfig.delete({ repo, assetId, userId: user.userId });
      return jsonResponse(200, {});
    }
  }

  if (parts.length === 2 && parts[1] === 'content' && request.method === 'GET') {
    const viewer = await optionalAuthenticatedUser({ auth, db, request });
    const viewerId = viewer === null ? null : viewer.userId;
    const head = await repo.getAssetById(assetId, assetType);
    if (head === null || String(head.asset_type) !== assetType) {
      return jsonResponse(404, { message: 'not found' });
    }
    const result = await assetConfig.getContent({ repo, assetId, userId: viewerId, head });
    return jsonResponse(200, result, anonymousPublicResponseHeaders(request, viewer === null && String(head.visibility) === 'public'));
  }

  if (parts.length === 2 && parts[1] === 'download' && request.method === 'GET') {
    const viewer = await optionalAuthenticatedUser({ auth, db, request });
    const viewerId = viewer === null ? null : viewer.userId;
    const head = await repo.getAssetById(assetId, assetType);
    if (head === null || String(head.asset_type) !== assetType) {
      return jsonResponse(404, { message: 'not found' });
    }
    if (String(head.visibility) !== 'public' && String(head.owner_user_id) !== String(viewerId || '')) {
      return jsonResponse(404, { message: 'not found' });
    }
    const payload = await assetConfig.getContent({ repo, assetId, userId: viewerId, head });
    return assetDownloadResponse(payload, {
      head,
      versionNumber: payload.versionNumber,
      headers: anonymousPublicResponseHeaders(request, viewer === null && String(head.visibility) === 'public'),
    });
  }

  if (parts.length === 2 && parts[1] === 'visibility' && request.method === 'PUT') {
    const user = await requireAssetWriteUser({ auth, db, repo, request, allowedOrigins });
    const payload = await readJsonBody(request);
    const visibility = requireBodyString(payload.visibility, 'visibility is required');
    const result = await assetConfig.updateVisibility({ repo, assetId, visibility, versionNumber: payload.versionNumber, userId: user.userId });
    return jsonResponse(200, result);
  }

  if (parts.length === 2 && parts[1] === 'meta' && request.method === 'PATCH') {
    const user = await requireAssetWriteUser({ auth, db, repo, request, allowedOrigins });
    const payload = await readJsonBody(request);
    const result = await assetConfig.updateMeta({ repo, assetId, payload, user });
    return jsonResponse(200, result);
  }

  if (parts.length === 2 && parts[1] === 'versions' && request.method === 'GET') {
    const viewer = await optionalAuthenticatedUser({ auth, db, request });
    const result = await assetConfig.listVersions({ repo, assetId, userId: viewer === null ? null : viewer.userId });
    return jsonResponse(200, result, anonymousPublicResponseHeaders(request, viewer === null));
  }

  if (parts.length === 3 && parts[1] === 'versions' && request.method === 'GET') {
    const viewer = await optionalAuthenticatedUser({ auth, db, request });
    const versionNumber = parts[2];
    const result = await assetConfig.getVersion({ repo, assetId, versionNumber, userId: viewer === null ? null : viewer.userId });
    return jsonResponse(200, result, anonymousPublicResponseHeaders(request, viewer === null && String(result.visibility) === 'public'));
  }

  if (parts.length === 3 && parts[1] === 'versions' && request.method === 'PATCH') {
    const user = await requireAssetWriteUser({ auth, db, repo, request, allowedOrigins });
    const payload = await readJsonBody(request);
    const versionNumber = parts[2];
    const result = await assetConfig.updateVersionNote({
      repo,
      assetId,
      versionNumber,
      changeSummary: payload.changeSummary,
      userId: user.userId,
    });
    return jsonResponse(200, result);
  }

  if (parts.length === 4 && parts[1] === 'versions' && parts[3] === 'content' && request.method === 'GET') {
    const viewer = await optionalAuthenticatedUser({ auth, db, request });
    const viewerId = viewer === null ? null : viewer.userId;
    const versionNumber = parts[2];
    const head = await repo.getAssetById(assetId, assetType);
    if (head === null || String(head.asset_type) !== assetType) {
      return jsonResponse(404, { message: 'not found' });
    }
    const result = await assetConfig.getVersionContent({ repo, assetId, versionNumber, userId: viewerId, head });
    return jsonResponse(200, result, anonymousPublicResponseHeaders(request, viewer === null && String(head.visibility) === 'public'));
  }

  if (parts.length === 4 && parts[1] === 'versions' && parts[3] === 'download' && request.method === 'GET') {
    const viewer = await optionalAuthenticatedUser({ auth, db, request });
    const viewerId = viewer === null ? null : viewer.userId;
    const versionNumber = parts[2];
    const head = await repo.getAssetById(assetId, assetType);
    if (head === null || String(head.asset_type) !== assetType) {
      return jsonResponse(404, { message: 'not found' });
    }
    if (String(head.visibility) !== 'public' && String(head.owner_user_id) !== String(viewerId || '')) {
      return jsonResponse(404, { message: 'not found' });
    }
    const payload = await assetConfig.getVersionContent({ repo, assetId, versionNumber, userId: viewerId, head });
    return assetDownloadResponse(payload, {
      head,
      versionNumber: payload.versionNumber,
      headers: anonymousPublicResponseHeaders(request, viewer === null && String(head.visibility) === 'public'),
    });
  }

  if (parts.length === 2 && parts[1] === 'subscribers' && request.method === 'GET') {
    const user = await requireAuthenticatedUser({ auth, db, request, allowedOrigins });
    const result = await assetConfig.listSubscribers({ repo, assetId, userId: user.userId });
    return jsonResponse(200, result);
  }

  if (parts.length === 2 && parts[1] === 'subscribe') {
    const user = await requireAuthenticatedUser({ auth, db, request, allowedOrigins });
    if (request.method === 'POST') {
      const result = await assetConfig.subscribe({ repo, assetId, userId: user.userId });
      return jsonResponse(200, result);
    }
    if (request.method === 'DELETE') {
      const result = await assetConfig.unsubscribe({ repo, assetId, userId: user.userId });
      return jsonResponse(200, result);
    }
  }

  if (parts.length === 2 && parts[1] === 'fork' && request.method === 'POST') {
    const user = await requireAssetWriteUser({ auth, db, repo, request, allowedOrigins });
    const payload = await readJsonBody(request);
    const result = await assetConfig.fork({ repo, assetId, payload, user });
    return jsonResponse(200, result);
  }

  return jsonResponse(404, { message: 'not found' });
}
