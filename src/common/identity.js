import { APIError } from '@better-auth/core/error';
import { HttpError, requireBodyString } from './http.js';

export const USER_ROLE_ADMIN = 'admin';

export const USER_ROLE_USER = 'user';

export const USER_ROLE_READONLY = 'readonly';

const RESERVED_IDENTITY_NAMES = new Set([
  'admin',
  'administrator',
  'owner',
  'root',
  'system',
  'feel8',
  'feel8fun',
  'f8',
  'f8studio',
  'support',
  'staff',
  'moderator',
  'official',
]);

function validateIdentityName(value, { allowReserved = false } = {}) {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  const canonical = canonicalizeIdentityName(text);
  if (RESERVED_IDENTITY_NAMES.has(canonical) && !allowReserved) {
    return false;
  }
  return isSafeDisplayText(text);
}

function isReservedIdentityName(value) {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  return RESERVED_IDENTITY_NAMES.has(canonicalizeIdentityName(text));
}

function validateDisplayName(value, { allowedReservedValue = '', allowReserved = false } = {}) {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  const canonical = canonicalizeIdentityName(text);
  if (
    RESERVED_IDENTITY_NAMES.has(canonical)
    && !allowReserved
    && canonical !== canonicalizeIdentityName(allowedReservedValue)
  ) {
    return false;
  }
  return isSafeDisplayText(text);
}

export function assertReservedNameAllowedForRole({ name, role }) {
  if (!isReservedIdentityName(name)) {
    return;
  }
  if (normalizeUserRole(role) === USER_ROLE_ADMIN) {
    return;
  }
  throw APIError.fromStatus('BAD_REQUEST', {
    message: 'reserved names are only available to admins',
  });
}

export function requireUserProfileName(value, { currentName = '', allowReserved = false } = {}) {
  const name = requireBodyString(value, 'name is required');
  if (!validateDisplayName(name, { allowedReservedValue: currentName, allowReserved })) {
    throw new HttpError(400, 'name must be 2-64 visible characters and not reserved');
  }
  return name;
}

function isSafeDisplayText(value) {
  const text = String(value || '').trim();
  if (text.length < 2 || text.length > 64) {
    return false;
  }
  if (/[\u0000-\u001F\u007F]/.test(text)) {
    return false;
  }
  return true;
}

function canonicalizeIdentityName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, '');
}

export function normalizeUserRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === USER_ROLE_ADMIN || role === USER_ROLE_READONLY) {
    return role;
  }
  return USER_ROLE_USER;
}

export function normalizeManagedUserRolePayload(payload) {
  if (payload.role !== undefined) {
    return requireUserRole(payload.role);
  }
  if (payload.isAdmin === true) {
    return USER_ROLE_ADMIN;
  }
  if (payload.canUpload === false) {
    return USER_ROLE_READONLY;
  }
  return USER_ROLE_USER;
}

function requireUserRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === USER_ROLE_ADMIN || role === USER_ROLE_USER || role === USER_ROLE_READONLY) {
    return role;
  }
  throw new HttpError(400, 'role must be admin, user, or readonly');
}
