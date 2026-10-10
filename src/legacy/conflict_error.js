import { normalizeAssetType, normalizeVersionNumber } from './validation.js';

export class AssetConflictError extends Error {
  constructor({ assetId, assetType, versionNumber }) {
    super(`Asset ${assetId} update conflict`);
    this.assetId = String(assetId);
    this.assetType = normalizeAssetType(assetType);
    this.versionNumber = normalizeVersionNumber(versionNumber);
  }
}
