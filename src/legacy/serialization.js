import { isPlainObject } from '../utils.js';
import { AssetValidationError } from './errors.js';

export function parseJsonArray(value) {
  if (typeof value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

export function toBinaryContent(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return numericArrayToUint8Array(value);
  }
  if (!isPlainObject(value)) {
    return null;
  }
  if (Array.isArray(value.data)) {
    return numericArrayToUint8Array(value.data);
  }
  if (Array.isArray(value.bytes)) {
    return numericArrayToUint8Array(value.bytes);
  }
  if (typeof value.base64 === 'string' && value.base64) {
    return base64ToUint8Array(value.base64);
  }
  return null;
}

function numericArrayToUint8Array(values) {
  const bytes = [];
  for (const value of values) {
    const numberValue = Number(value);
    if (!Number.isInteger(numberValue) || numberValue < 0 || numberValue > 255) {
      return null;
    }
    bytes.push(numberValue);
  }
  return new Uint8Array(bytes);
}

function base64ToUint8Array(value) {
  const decoded = atob(String(value));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

export function parseJsonObject(value, errorMessage = 'stored version content must be a JSON object') {
  if (isPlainObject(value)) {
    return deepCloneJson(value);
  }
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (!isPlainObject(parsed)) {
      throw new AssetValidationError(errorMessage);
    }
    return parsed;
  } catch (error) {
    if (error instanceof AssetValidationError) {
      throw error;
    }
    throw new AssetValidationError(errorMessage);
  }
}

export function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
