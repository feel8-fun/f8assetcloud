import { AssetPermissionError, AssetValidationError } from './errors.js';
import { canonicalUtcTimestamp, escapeLikePattern, isPlainObject, nullableString } from '../utils.js';

const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

const MAX_ASSET_ID_LENGTH = 128;

const MAX_ASSET_NAME_LENGTH = 120;

const MAX_DESCRIPTION_BYTES = 16 * 1024;

const MAX_CHANGE_SUMMARY_LENGTH = 280;

const MAX_TAG_COUNT = 20;

const MAX_TAG_LENGTH = 48;

const MAX_ASSET_FIELD_LENGTH = 128;

const SAFE_ASSET_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;

const textEncoder = new TextEncoder();

export function enforceContentSizeLimit(contentJson) {
  const byteLength = new TextEncoder().encode(String(contentJson)).length;
  if (byteLength > MAX_CONTENT_BYTES) {
    throw new AssetValidationError(
      `content exceeds maximum allowed size (${Math.round(byteLength / 1024)}KB, limit ${Math.round(MAX_CONTENT_BYTES / 1024)}KB)`,
    );
  }
}

export function normalizeUserRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'admin' || role === 'readonly') {
    return role;
  }
  return 'user';
}

export function applyAssetQueryFilters({ filters, bindings, query, assetType, extraFilters }) {
  if (query) {
    const match = `%${escapeLikePattern(String(query).trim().toLowerCase())}%`;
    if (assetType === 'variant') {
      filters.push("(LOWER(h.name) LIKE ? ESCAPE '\\' OR LOWER(h.description) LIKE ? ESCAPE '\\' OR LOWER(h.tags_json) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(vd.base_node_type, '')) LIKE ? ESCAPE '\\')");
      bindings.push(match, match, match, match);
    } else {
      filters.push("(LOWER(h.name) LIKE ? ESCAPE '\\' OR LOWER(h.description) LIKE ? ESCAPE '\\' OR LOWER(h.tags_json) LIKE ? ESCAPE '\\')");
      bindings.push(match, match, match);
    }
  }
  if (assetType === 'variant') {
    if (extraFilters.variantKind) {
      filters.push('vd.variant_kind = ?');
      bindings.push(String(extraFilters.variantKind));
    }
    if (extraFilters.baseNodeType) {
      filters.push('vd.base_node_type = ?');
      bindings.push(String(extraFilters.baseNodeType));
    }
  }
}

export function applyVisibilityOwnerFilters({ filters, bindings, userId, visibility, owner }) {
  const normalizedOwner = normalizeOwnerFilter(owner);
  const normalizedVisibility = normalizeVisibilityFilter(visibility);
  const viewerUserId = userId ? String(userId) : '';

  if (!viewerUserId) {
    filters.push("h.visibility = 'public'");
    if (normalizedOwner === 'me' || normalizedOwner === 'subscribed') {
      filters.push('1 = 0');
    }
    return;
  }

  if (normalizedOwner === 'me') {
    filters.push('h.owner_user_id = ?');
    bindings.push(viewerUserId);
  } else if (normalizedOwner === 'subscribed') {
    filters.push('EXISTS (SELECT 1 FROM asset_subscriptions s WHERE s.asset_id = h.asset_id AND s.subscriber_user_id = ?)');
    bindings.push(viewerUserId);
  } else if (normalizedOwner === 'public') {
    filters.push("h.visibility = 'public'");
  } else {
    filters.push("(h.visibility = 'public' OR h.owner_user_id = ?)");
    bindings.push(viewerUserId);
  }

  if (normalizedVisibility === 'public') {
    filters.push("h.visibility = 'public'");
  } else if (normalizedVisibility === 'private') {
    filters.push('h.owner_user_id = ? AND h.visibility = ?');
    bindings.push(viewerUserId, 'private');
  }
}

export function ensureCanView(head, userId) {
  if (String(head.visibility) === 'public') {
    return;
  }
  if (String(head.owner_user_id) !== String(userId || '')) {
    throw new AssetPermissionError('forbidden');
  }
}

export function hasSubscription(subscription) {
  return subscription !== null
    && subscription !== undefined
    && subscription.subscribed_at !== undefined
    && subscription.subscribed_at !== null;
}

export function normalizeVisibility(value) {
  return String(value || 'private').trim() === 'public' ? 'public' : 'private';
}

export function normalizeAssetType(value) {
  const text = String(value || '').trim();
  if (text !== 'variant' && text !== 'component' && text !== 'modding_recipe') {
    throw new AssetValidationError('assetType must be variant, component, or modding_recipe');
  }
  return text;
}

function normalizeOwnerFilter(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text === 'me' || text === 'subscribed' || text === 'public') {
    return text;
  }
  throw new AssetValidationError('owner must be me, subscribed, or public');
}

function normalizeVisibilityFilter(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text === 'public' || text === 'private') {
    return text;
  }
  throw new AssetValidationError('visibility must be public or private');
}

export function normalizeVersionNumber(value) {
  const versionNumber = Number.parseInt(String(value), 10);
  if (!Number.isFinite(versionNumber) || versionNumber <= 0) {
    throw new AssetValidationError('versionNumber must be a positive integer');
  }
  return versionNumber;
}

export function normalizeOptionalVersionNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  return normalizeVersionNumber(value);
}

export function nullableNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function normalizeTags(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length > MAX_TAG_COUNT) {
    throw new AssetValidationError(`tags must contain at most ${MAX_TAG_COUNT} items`);
  }
  const tags = value
    .map((item) => requireConstrainedString(item, 'tag must be a non-empty string', {
      maxLength: MAX_TAG_LENGTH,
      fieldLabel: 'tag',
    }))
    .filter((item) => item.length > 0);
  if (tags.length > MAX_TAG_COUNT) {
    throw new AssetValidationError(`tags must contain at most ${MAX_TAG_COUNT} items`);
  }
  return tags;
}

export function parseCursor(value) {
  const cursor = Number.parseInt(String(value || '0'), 10);
  return Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
}

export function normalizeIsoString(value, fallback) {
  const text = String(value || '').trim();
  if (text) {
    return normalizeDbTimestamp(text);
  }
  return normalizeDbTimestamp(fallback);
}

export function normalizeDbTimestamp(value) {
  if (value instanceof Date) {
    return canonicalUtcTimestamp(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return canonicalUtcTimestamp(value);
  }
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return canonicalUtcTimestamp(numeric);
  }
  const normalized = canonicalUtcTimestamp(text);
  return normalized || text;
}

export function stableJson(value) {
  return JSON.stringify(value);
}

export function rejectLocalPathFields(value, path = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      rejectLocalPathFields(value[index], [...path, String(index)]);
    }
    return;
  }
  if (!isPlainObject(value)) {
    if (typeof value === 'string' && looksLikeAbsoluteLocalPath(value)) {
      throw new AssetValidationError(`modding recipe published content must not contain absolute local paths at ${formatJsonPath(path)}`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (isLocalOnlyPathFieldName(key) && child !== null && child !== undefined && String(child).trim() !== '') {
      throw new AssetValidationError(`modding recipe published content must not contain local path field ${formatJsonPath(childPath)}`);
    }
    rejectLocalPathFields(child, childPath);
  }
}

function isLocalOnlyPathFieldName(key) {
  const name = String(key || '').trim().toLowerCase();
  return name === 'lasttargetpath'
    || name === 'targetpath'
    || name === 'resolvedgameroot'
    || name === 'gameroot'
    || name === 'executablepath'
    || name === 'exepath'
    || name === 'localpath'
    || name === 'installpath'
    || name === 'sourcepath';
}

function looksLikeAbsoluteLocalPath(value) {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  if (/^file:\/\//i.test(text)) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    return true;
  }
  if (/^\\\\/.test(text) || /^\/\/[^/]/.test(text)) {
    return true;
  }
  return /^\/(Users|home|tmp|var|mnt|Volumes|opt|root|srv|media|run)\//.test(text);
}

function formatJsonPath(parts) {
  if (parts.length === 0) {
    return '$';
  }
  return `$${parts.map((part) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`)).join('')}`;
}

export function requireAssetIdentifier(value, message) {
  const text = requireConstrainedString(value, message, {
    maxLength: MAX_ASSET_ID_LENGTH,
    fieldLabel: 'asset id',
  });
  if (!SAFE_ASSET_ID_PATTERN.test(text)) {
    throw new AssetValidationError('asset id must use URL-safe characters only');
  }
  return text;
}

export function requireAssetName(value, message) {
  return requireConstrainedString(value, message, {
    maxLength: MAX_ASSET_NAME_LENGTH,
    fieldLabel: 'name',
  });
}

export function requireAssetField(value, message) {
  return requireConstrainedString(value, message, {
    maxLength: MAX_ASSET_FIELD_LENGTH,
    fieldLabel: 'field',
  });
}

export function optionalAssetField(value) {
  const text = nullableString(value);
  if (text === null) {
    return null;
  }
  return requireConstrainedString(text, 'field is too long', {
    maxLength: MAX_ASSET_FIELD_LENGTH,
    fieldLabel: 'field',
  });
}

export function optionalDescription(value) {
  const text = String(value || '');
  ensureMaxByteLength(text, MAX_DESCRIPTION_BYTES, 'description');
  return text;
}

export function normalizeChangeSummary(value) {
  const text = nullableString(value);
  if (text === null) {
    return null;
  }
  if (text.length > MAX_CHANGE_SUMMARY_LENGTH) {
    throw new AssetValidationError(`changeSummary must be at most ${MAX_CHANGE_SUMMARY_LENGTH} characters`);
  }
  return text;
}

function requireConstrainedString(value, message, { maxLength, fieldLabel }) {
  const text = String(value || '').trim();
  if (!text) {
    throw new AssetValidationError(message);
  }
  if (text.length > Number(maxLength)) {
    throw new AssetValidationError(`${fieldLabel} must be at most ${maxLength} characters`);
  }
  return text;
}

function ensureMaxByteLength(value, maxBytes, fieldLabel) {
  const byteLength = textEncoder.encode(String(value || '')).length;
  if (byteLength > Number(maxBytes)) {
    throw new AssetValidationError(`${fieldLabel} must be at most ${Math.round(Number(maxBytes) / 1024)} KiB`);
  }
}

export function requireNonEmptyString(value, message) {
  const text = String(value || '').trim();
  if (!text) {
    throw new AssetValidationError(message);
  }
  return text;
}
