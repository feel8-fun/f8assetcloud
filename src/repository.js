import { compressGzip, escapeLikePattern, isPlainObject, nowIso, nullableString, stringOrDefault, toBoolean } from './utils.js';
import { AssetConflictError } from './legacy/conflict_error.js';
import { AssetNotFoundError, AssetPermissionError, AssetValidationError } from './legacy/errors.js';
import { applyAssetQueryFilters, applyVisibilityOwnerFilters, enforceContentSizeLimit, ensureCanView, normalizeAssetType, normalizeChangeSummary, normalizeDbTimestamp, normalizeOptionalVersionNumber, normalizeTags, normalizeUserRole, normalizeVersionNumber, normalizeVisibility, optionalDescription, parseCursor, requireAssetName } from './legacy/validation.js';
import { adminAssetDetailFromRows, adminAssetSummaryFromRow, assetSubscriberFromRow, assetVersionSummaryFromRow, decodeVersionContent, normalizeComponentCreatePayload, normalizeComponentUpdatePayload, normalizeModdingRecipeCreatePayload, normalizeModdingRecipeUpdatePayload, normalizeVariantCreatePayload, normalizeVariantUpdatePayload, siteSettingsPayloadFromRow, typedAssetContentPayloadFromRows, typedAssetDetailPayloadFromRows, typedAssetSummaryPayloadFromRow } from './legacy/records.js';
import { deepCloneJson } from './legacy/serialization.js';

const PAGE_SIZE = 100;

export class AssetRepository {
  constructor(db) {
    this._db = db;
    this._hasVariantDetailsTableCached = null;
  }

  async listUsers({ query, cursor }) {
    const filters = ['1 = 1'];
    const bindings = [];
    if (String(query || '').trim()) {
      const match = `%${escapeLikePattern(String(query).trim().toLowerCase())}%`;
      filters.push("(LOWER(u.name) LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE ? ESCAPE '\\')");
      bindings.push(match, match);
    }
    const start = parseCursor(cursor);
    const sql = `
      SELECT
        u.id,
        u.name,
        u.email,
        u.emailVerified,
        u.role,
        u.createdAt,
        u.updatedAt,
        COALESCE(assets.asset_count, 0) AS asset_count
      FROM user u
      LEFT JOIN (
        SELECT owner_user_id, COUNT(*) AS asset_count
        FROM asset_heads
        GROUP BY owner_user_id
      ) assets ON assets.owner_user_id = u.id
      WHERE ${filters.join(' AND ')}
      ORDER BY LOWER(u.name), u.id
      LIMIT ? OFFSET ?
    `;
    const result = await this._db.prepare(sql).bind(...bindings, PAGE_SIZE + 1, start).all();
    const rows = Array.isArray(result.results) ? result.results : [];
    const hasMore = rows.length > PAGE_SIZE;
    const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    return {
      entries: items.map((row) => ({
        userId: String(row.id),
        name: stringOrDefault(row.name, String(row.email || '')),
        email: String(row.email || ''),
        emailVerified: Number(row.emailVerified || 0) !== 0,
        role: normalizeUserRole(row.role),
        isAdmin: normalizeUserRole(row.role) === 'admin',
        canUpload: normalizeUserRole(row.role) !== 'readonly',
        assetCount: Number(row.asset_count || 0),
        createdAt: normalizeDbTimestamp(row.createdAt),
        updatedAt: normalizeDbTimestamp(row.updatedAt),
      })),
      nextCursor: hasMore ? String(start + PAGE_SIZE) : null,
    };
  }

  async getUserByIdWithStats(userId) {
    const row = await this._db.prepare(
      `SELECT
         u.id,
         u.name,
         u.email,
         u.emailVerified,
         u.role,
         u.createdAt,
         u.updatedAt,
         COALESCE(assets.asset_count, 0) AS asset_count
       FROM user u
       LEFT JOIN (
         SELECT owner_user_id, COUNT(*) AS asset_count
         FROM asset_heads
         GROUP BY owner_user_id
       ) assets ON assets.owner_user_id = u.id
       WHERE u.id = ?`,
    )
      .bind(String(userId))
      .first();
    if (row === null) {
      return null;
    }
    return {
      userId: String(row.id),
      name: stringOrDefault(row.name, String(row.email || '')),
      email: String(row.email || ''),
      emailVerified: Number(row.emailVerified || 0) !== 0,
      role: normalizeUserRole(row.role),
      isAdmin: normalizeUserRole(row.role) === 'admin',
      canUpload: normalizeUserRole(row.role) !== 'readonly',
      assetCount: Number(row.asset_count || 0),
      createdAt: normalizeDbTimestamp(row.createdAt),
      updatedAt: normalizeDbTimestamp(row.updatedAt),
    };
  }

  async getUserById(userId) {
    const row = await this._db.prepare(
      `SELECT id, name, email, emailVerified, role, createdAt, updatedAt
       FROM user
       WHERE id = ?`,
    )
      .bind(String(userId))
      .first();
    if (row === null) {
      return null;
    }
    return {
      userId: String(row.id),
      name: stringOrDefault(row.name, String(row.email || '')),
      email: String(row.email || ''),
      emailVerified: Number(row.emailVerified || 0) !== 0,
      role: normalizeUserRole(row.role),
      isAdmin: normalizeUserRole(row.role) === 'admin',
      canUpload: normalizeUserRole(row.role) !== 'readonly',
      createdAt: normalizeDbTimestamp(row.createdAt),
      updatedAt: normalizeDbTimestamp(row.updatedAt),
    };
  }

  async isUserNameTaken({ name, excludeUserId = '' }) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      return false;
    }
    const row = await this._db.prepare(
      `SELECT 1
       FROM user
       WHERE name = ?
         AND (? = '' OR id != ?)
       LIMIT 1`,
    )
      .bind(normalizedName, String(excludeUserId || ''), String(excludeUserId || ''))
      .first();
    return row !== null;
  }

  async getSiteSettings() {
    await this._ensureSiteSettingsRow();
    const row = await this._db.prepare(
      `SELECT allow_user_registration, updated_at, updated_by_user_id
       FROM site_settings
       WHERE id = 1`,
    ).first();
    return siteSettingsPayloadFromRow(row);
  }

  async updateSiteSettings({ allowUserRegistration, updatedByUserId }) {
    await this._ensureSiteSettingsRow();
    const current = await this.getSiteSettings();
    const nextAllowUserRegistration = (
      allowUserRegistration === undefined
        ? current.allowUserRegistration
        : toBoolean(allowUserRegistration)
    );
    await this._db.prepare(
      `UPDATE site_settings
       SET allow_user_registration = ?,
           updated_at = ?,
           updated_by_user_id = ?
       WHERE id = 1`,
    )
      .bind(
        nextAllowUserRegistration ? 1 : 0,
        nowIso(),
        nullableString(updatedByUserId),
      )
      .run();
    return this.getSiteSettings();
  }

  async adminPurgeAllAssets() {
    const cloudCounts = await this._db.prepare(`SELECT
      (SELECT COUNT(*) FROM cloud_assets) AS assets,
      (SELECT COUNT(*) FROM cloud_versions) AS versions,
      (SELECT COUNT(*) FROM cloud_asset_follows) AS follows`).first();
    await this._db.prepare('DELETE FROM cloud_assets').run();
    await this._db.prepare('DELETE FROM cloud_publish_requests').run();
    const deletedSubscriptionsResult = await this._db.prepare(
      'DELETE FROM asset_subscriptions',
    ).run();
    const deletedVersionsResult = await this._db.prepare(
      'DELETE FROM asset_versions',
    ).run();
    let deletedVariantDetails = 0;
    if (await this._hasVariantDetailsTable()) {
      const deletedVariantDetailsResult = await this._db.prepare(
        'DELETE FROM variant_details',
      ).run();
      deletedVariantDetails = Number(deletedVariantDetailsResult.meta?.changes || 0);
    }
    const deletedHeadsResult = await this._db.prepare(
      'DELETE FROM asset_heads',
    ).run();
    return {
      deletedAssetSubscriptions: Number(deletedSubscriptionsResult.meta?.changes || 0) + Number(cloudCounts?.follows || 0),
      deletedAssetVersions: Number(deletedVersionsResult.meta?.changes || 0) + Number(cloudCounts?.versions || 0),
      deletedVariantDetails,
      deletedAssets: Number(deletedHeadsResult.meta?.changes || 0) + Number(cloudCounts?.assets || 0),
    };
  }

  async listManagedAssets({ assetType, ownerUserId, query, cursor, kind = '', baseNodeType = '' }) {
    const filters = ['1 = 1'];
    const bindings = [];
    const normalizedAssetType = String(assetType || '').trim();
    if (normalizedAssetType) {
      filters.push('h.asset_type = ?');
      bindings.push(normalizeAssetType(normalizedAssetType));
    }
    const ownerFilter = String(ownerUserId || '').trim();
    if (ownerFilter) {
      filters.push('h.owner_user_id = ?');
      bindings.push(ownerFilter);
    }
    if (String(query || '').trim()) {
      const match = `%${escapeLikePattern(String(query).trim().toLowerCase())}%`;
      if (normalizedAssetType === 'variant') {
        filters.push("(LOWER(h.name) LIKE ? ESCAPE '\\' OR LOWER(h.description) LIKE ? ESCAPE '\\' OR LOWER(h.tags_json) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(vd.base_node_type, '')) LIKE ? ESCAPE '\\')");
        bindings.push(match, match, match, match);
      } else {
        filters.push("(LOWER(h.name) LIKE ? ESCAPE '\\' OR LOWER(h.description) LIKE ? ESCAPE '\\' OR LOWER(h.tags_json) LIKE ? ESCAPE '\\')");
        bindings.push(match, match, match);
      }
    }
    if (normalizedAssetType === 'variant') {
      const normalizedKind = String(kind || '').trim();
      if (normalizedKind) {
        filters.push('vd.variant_kind = ?');
        bindings.push(normalizedKind);
      }
      const normalizedBaseNodeType = String(baseNodeType || '').trim();
      if (normalizedBaseNodeType) {
        filters.push('vd.base_node_type = ?');
        bindings.push(normalizedBaseNodeType);
      }
    }

    const start = parseCursor(cursor);
    const sql = normalizedAssetType === 'variant'
      ? `
        SELECT
          h.*,
          vd.variant_kind,
          vd.base_node_type,
          vd.service_class,
          vd.operator_class,
          u.name AS owner_display_name,
          v.created_at AS version_created_at,
          v.created_by_user_id,
          v.change_summary,
          v.version_number
        FROM asset_heads h
        LEFT JOIN variant_details vd ON vd.asset_id = h.asset_id
        JOIN asset_versions v
          ON v.asset_id = h.asset_id AND v.version_number = h.current_version_number
        LEFT JOIN user u ON u.id = h.owner_user_id
        WHERE ${filters.join(' AND ')}
        ORDER BY h.updated_at DESC, h.asset_id
        LIMIT ? OFFSET ?
      `
      : `
        SELECT
          h.*,
          u.name AS owner_display_name,
          v.created_at AS version_created_at,
          v.created_by_user_id,
          v.change_summary,
          v.version_number
        FROM asset_heads h
        JOIN asset_versions v
          ON v.asset_id = h.asset_id AND v.version_number = h.current_version_number
        LEFT JOIN user u ON u.id = h.owner_user_id
        WHERE ${filters.join(' AND ')}
        ORDER BY h.updated_at DESC, h.asset_id
        LIMIT ? OFFSET ?
      `;
    const result = await this._db.prepare(sql).bind(...bindings, PAGE_SIZE + 1, start).all();
    const rows = Array.isArray(result.results) ? result.results : [];
    const hasMore = rows.length > PAGE_SIZE;
    const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const resolvedItems = normalizedAssetType === 'variant'
      ? items
      : await this._mergeVariantDetailsIntoRows(items);
    return {
      entries: resolvedItems.map((row) => adminAssetSummaryFromRow(row)),
      nextCursor: hasMore ? String(start + PAGE_SIZE) : null,
    };
  }

  async getManagedAsset({ assetId, assetTypeHint = '' }) {
    const head = await this._findAssetHeadRow(assetId, { assetTypeHint });
    if (head === null) {
      return null;
    }
    if (assetTypeHint && String(head.asset_type) !== String(assetTypeHint)) {
      return null;
    }
    const version = await this._findAssetVersionRow(assetId, Number(head.current_version_number));
    if (version === null) {
      return null;
    }
    return adminAssetDetailFromRows({ head, version });
  }

  async adminDeleteAsset({ assetId, assetTypeHint = '' }) {
    const existing = await this._findAssetHeadRow(assetId, { assetTypeHint });
    if (existing === null) {
      return false;
    }
    if (assetTypeHint && String(existing.asset_type) !== String(assetTypeHint)) {
      return false;
    }
    await this._db.prepare('DELETE FROM asset_heads WHERE asset_id = ?')
      .bind(String(assetId))
      .run();

    return true;
  }

  async adminUpdateAssetVisibility({ assetId, visibility, assetTypeHint = '' }) {
    const existing = await this._findAssetHeadRow(assetId, { assetTypeHint });
    if (existing === null) {
      return null;
    }
    if (assetTypeHint && String(existing.asset_type) !== String(assetTypeHint)) {
      return null;
    }
    await this._db.prepare(
      `UPDATE asset_heads
       SET visibility = ?,
           updated_at = ?
       WHERE asset_id = ?`,
    )
      .bind(normalizeVisibility(visibility), nowIso(), String(assetId))
      .run();
    return this.getManagedAsset({ assetId, assetTypeHint });
  }

  async createVariant({ payload, user }) {
    const normalized = normalizeVariantCreatePayload(payload, user);
    return this._createAsset({ normalized, userId: user.userId });
  }

  async updateVariant({ variantId, payload, user }) {
    const existing = await this._requireOwnedAsset({ assetId: variantId, assetType: 'variant', userId: user.userId });
    const normalized = normalizeVariantUpdatePayload(payload, existing, user);
    return this._updateAsset({ existing, normalized, userId: user.userId });
  }

  async deleteVariant({ variantId, userId }) {
    await this._deleteOwnedAsset({ assetId: variantId, assetType: 'variant', userId });
  }

  async getVariant({ variantId, userId, head = null }) {
    return this._getAssetDetailPayload({ assetId: variantId, assetType: 'variant', userId, versionNumber: null, head });
  }

  async listVariants({ userId, kind, baseNodeType, query, visibility, owner, cursor }) {
    return this._listTypedAssetSummaries({
      assetType: 'variant',
      userId,
      query,
      cursor,
      visibility,
      owner,
      extraFilters: {
        variantKind: String(kind || '').trim(),
        baseNodeType: String(baseNodeType || '').trim(),
      },
    });
  }

  async listVariantVersions({ variantId, userId, cursor }) {
    return this._listAssetVersions({ assetId: variantId, assetType: 'variant', userId, cursor });
  }

  async listVariantSubscribers({ variantId, userId, cursor }) {
    return this._listAssetSubscribers({ assetId: variantId, assetType: 'variant', userId, cursor });
  }

  async getVariantVersion({ variantId, versionNumber, userId, head = null }) {
    return this._getAssetDetailPayload({ assetId: variantId, assetType: 'variant', userId, versionNumber, head });
  }

  async getVariantContent({ variantId, userId, head = null }) {
    return this._getAssetContentPayload({ assetId: variantId, assetType: 'variant', userId, versionNumber: null, head });
  }

  async getVariantVersionContent({ variantId, versionNumber, userId, head = null }) {
    return this._getAssetContentPayload({ assetId: variantId, assetType: 'variant', userId, versionNumber, head });
  }

  async subscribeVariant({ variantId, userId }) {
    return this._subscribeAsset({ assetId: variantId, assetType: 'variant', userId });
  }

  async unsubscribeVariant({ variantId, userId }) {
    return this._unsubscribeAsset({ assetId: variantId, assetType: 'variant', userId });
  }

  async forkVariant({ variantId, payload, user }) {
    return this._forkAsset({ assetId: variantId, assetType: 'variant', payload, user });
  }

  async updateVariantVisibility({ variantId, visibility, versionNumber, userId }) {
    return this._updateAssetVisibility({ assetId: variantId, assetType: 'variant', visibility, versionNumber, userId });
  }

  async updateVariantVersionNote({ variantId, versionNumber, changeSummary, userId }) {
    return this._updateAssetVersionNote({
      assetId: variantId,
      assetType: 'variant',
      versionNumber,
      changeSummary,
      userId,
    });
  }

  async createComponent({ payload, user }) {
    const normalized = normalizeComponentCreatePayload(payload, user);
    return this._createAsset({ normalized, userId: user.userId });
  }

  async updateComponent({ componentId, payload, user }) {
    const existing = await this._requireOwnedAsset({ assetId: componentId, assetType: 'component', userId: user.userId });
    const normalized = normalizeComponentUpdatePayload(payload, existing, user);
    return this._updateAsset({ existing, normalized, userId: user.userId });
  }

  async deleteComponent({ componentId, userId }) {
    await this._deleteOwnedAsset({ assetId: componentId, assetType: 'component', userId });
  }

  async getComponent({ componentId, userId, head = null }) {
    return this._getAssetDetailPayload({ assetId: componentId, assetType: 'component', userId, versionNumber: null, head });
  }

  async listComponents({ userId, query, visibility, owner, cursor }) {
    return this._listTypedAssetSummaries({
      assetType: 'component',
      userId,
      query,
      cursor,
      visibility,
      owner,
      extraFilters: {},
    });
  }

  async listComponentVersions({ componentId, userId, cursor }) {
    return this._listAssetVersions({ assetId: componentId, assetType: 'component', userId, cursor });
  }

  async listComponentSubscribers({ componentId, userId, cursor }) {
    return this._listAssetSubscribers({ assetId: componentId, assetType: 'component', userId, cursor });
  }

  async getComponentVersion({ componentId, versionNumber, userId, head = null }) {
    return this._getAssetDetailPayload({ assetId: componentId, assetType: 'component', userId, versionNumber, head });
  }

  async getComponentContent({ componentId, userId, head = null }) {
    return this._getAssetContentPayload({ assetId: componentId, assetType: 'component', userId, versionNumber: null, head });
  }

  async getComponentVersionContent({ componentId, versionNumber, userId, head = null }) {
    return this._getAssetContentPayload({ assetId: componentId, assetType: 'component', userId, versionNumber, head });
  }

  async subscribeComponent({ componentId, userId }) {
    return this._subscribeAsset({ assetId: componentId, assetType: 'component', userId });
  }

  async unsubscribeComponent({ componentId, userId }) {
    return this._unsubscribeAsset({ assetId: componentId, assetType: 'component', userId });
  }

  async forkComponent({ componentId, payload, user }) {
    return this._forkAsset({ assetId: componentId, assetType: 'component', payload, user });
  }

  async updateComponentVisibility({ componentId, visibility, versionNumber, userId }) {
    return this._updateAssetVisibility({ assetId: componentId, assetType: 'component', visibility, versionNumber, userId });
  }

  async updateComponentVersionNote({ componentId, versionNumber, changeSummary, userId }) {
    return this._updateAssetVersionNote({
      assetId: componentId,
      assetType: 'component',
      versionNumber,
      changeSummary,
      userId,
    });
  }

  async createModdingRecipe({ payload, user }) {
    const normalized = normalizeModdingRecipeCreatePayload(payload, user);
    return this._createAsset({ normalized, userId: user.userId });
  }

  async updateModdingRecipe({ recipeId, payload, user }) {
    const existing = await this._requireOwnedAsset({ assetId: recipeId, assetType: 'modding_recipe', userId: user.userId });
    const normalized = normalizeModdingRecipeUpdatePayload(payload, existing, user);
    return this._updateAsset({ existing, normalized, userId: user.userId });
  }

  async deleteModdingRecipe({ recipeId, userId }) {
    await this._deleteOwnedAsset({ assetId: recipeId, assetType: 'modding_recipe', userId });
  }

  async getModdingRecipe({ recipeId, userId, head = null }) {
    return this._getAssetDetailPayload({ assetId: recipeId, assetType: 'modding_recipe', userId, versionNumber: null, head });
  }

  async listModdingRecipes({ userId, query, visibility, owner, cursor }) {
    return this._listTypedAssetSummaries({
      assetType: 'modding_recipe',
      userId,
      query,
      cursor,
      visibility,
      owner,
      extraFilters: {},
    });
  }

  async listModdingRecipeVersions({ recipeId, userId, cursor }) {
    return this._listAssetVersions({ assetId: recipeId, assetType: 'modding_recipe', userId, cursor });
  }

  async listModdingRecipeSubscribers({ recipeId, userId, cursor }) {
    return this._listAssetSubscribers({ assetId: recipeId, assetType: 'modding_recipe', userId, cursor });
  }

  async getModdingRecipeVersion({ recipeId, versionNumber, userId, head = null }) {
    return this._getAssetDetailPayload({ assetId: recipeId, assetType: 'modding_recipe', userId, versionNumber, head });
  }

  async getModdingRecipeContent({ recipeId, userId, head = null }) {
    return this._getAssetContentPayload({ assetId: recipeId, assetType: 'modding_recipe', userId, versionNumber: null, head });
  }

  async getModdingRecipeVersionContent({ recipeId, versionNumber, userId, head = null }) {
    return this._getAssetContentPayload({ assetId: recipeId, assetType: 'modding_recipe', userId, versionNumber, head });
  }

  async subscribeModdingRecipe({ recipeId, userId }) {
    return this._subscribeAsset({ assetId: recipeId, assetType: 'modding_recipe', userId });
  }

  async unsubscribeModdingRecipe({ recipeId, userId }) {
    return this._unsubscribeAsset({ assetId: recipeId, assetType: 'modding_recipe', userId });
  }

  async forkModdingRecipe({ recipeId, payload, user }) {
    return this._forkAsset({ assetId: recipeId, assetType: 'modding_recipe', payload, user });
  }

  async updateModdingRecipeVisibility({ recipeId, visibility, versionNumber, userId }) {
    return this._updateAssetVisibility({ assetId: recipeId, assetType: 'modding_recipe', visibility, versionNumber, userId });
  }

  async updateModdingRecipeVersionNote({ recipeId, versionNumber, changeSummary, userId }) {
    return this._updateAssetVersionNote({
      assetId: recipeId,
      assetType: 'modding_recipe',
      versionNumber,
      changeSummary,
      userId,
    });
  }

  async updateModdingRecipeMeta({ recipeId, payload, user }) {
    return this._updateAssetMeta({ assetId: recipeId, assetType: 'modding_recipe', payload, userId: user.userId });
  }

  async _createAsset({ normalized, userId }) {
    const existing = await this._findAssetHeadRow(normalized.assetId);
    if (existing !== null) {
      throw new AssetValidationError('assetId already exists');
    }

    enforceContentSizeLimit(normalized.contentJson);
    await this._db.prepare(
      `INSERT INTO asset_heads (
         asset_id, asset_type, owner_user_id, visibility, current_version_number,
         name, description, tags_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        normalized.assetId,
        normalized.assetType,
        normalized.ownerUserId,
        normalized.visibility,
        1,
        normalized.name,
        normalized.description,
        JSON.stringify(normalized.tags),
        normalized.createdAt,
        normalized.updatedAt,
      )
      .run();

    if (normalized.assetType === 'variant') {
      await this._upsertVariantDetails(normalized.assetId, normalized.variantDetails);
    }

    await this._insertAssetVersion({
      assetId: normalized.assetId,
      versionNumber: 1,
      contentJson: normalized.contentJson,
      createdAt: normalized.updatedAt,
      createdByUserId: userId,
      changeSummary: normalized.changeSummary,
    });
    return this._getAssetDetailPayload({ assetId: normalized.assetId, assetType: normalized.assetType, userId, versionNumber: null });
  }

  async _updateAsset({ existing, normalized, userId }) {
    if (normalized.versionNumber !== null && Number(normalized.versionNumber) !== Number(existing.current_version_number)) {
      throw new AssetConflictError({
        assetId: existing.asset_id,
        assetType: existing.asset_type,
        versionNumber: Number(existing.current_version_number),
      });
    }

    enforceContentSizeLimit(normalized.contentJson);
    const nextVersionNumber = Number(existing.current_version_number) + 1;
    await this._db.prepare(
      `UPDATE asset_heads
       SET visibility = ?,
           current_version_number = ?,
           name = ?,
           description = ?,
           tags_json = ?,
           updated_at = ?
       WHERE asset_id = ?`,
    )
      .bind(
        normalized.visibility,
        nextVersionNumber,
        normalized.name,
        normalized.description,
        JSON.stringify(normalized.tags),
        normalized.updatedAt,
        normalized.assetId,
      )
      .run();

    if (normalized.assetType === 'variant') {
      await this._upsertVariantDetails(normalized.assetId, normalized.variantDetails);
    } else {
      await this._deleteVariantDetails(normalized.assetId);
    }

    await this._insertAssetVersion({
      assetId: normalized.assetId,
      versionNumber: nextVersionNumber,
      contentJson: normalized.contentJson,
      createdAt: normalized.updatedAt,
      createdByUserId: userId,
      changeSummary: normalized.changeSummary,
    });
    await this._db.prepare(
      `UPDATE asset_subscriptions
       SET last_seen_version_number = COALESCE(last_seen_version_number, ?)
       WHERE asset_id = ? AND subscriber_user_id = ?`,
    )
      .bind(nextVersionNumber, normalized.assetId, userId)
      .run();
    return this._getAssetDetailPayload({ assetId: normalized.assetId, assetType: normalized.assetType, userId, versionNumber: null });
  }

  async _deleteOwnedAsset({ assetId, assetType, userId }) {
    await this._requireOwnedAsset({ assetId, assetType, userId });
    await this._db.prepare('DELETE FROM asset_heads WHERE asset_id = ?')
      .bind(String(assetId))
      .run();
  }

  async _getAssetContext({ assetId, assetType, userId, versionNumber, includeContent = false, head = null }) {
    const resolvedHead = head ?? await this.getAssetById(assetId, assetType);
    if (resolvedHead === null || String(resolvedHead.asset_type) !== assetType) {
      throw new AssetNotFoundError(`Asset ${assetId} not found`);
    }
    ensureCanView(resolvedHead, userId);
    const targetVersionNumber = versionNumber === null ? Number(resolvedHead.current_version_number) : normalizeVersionNumber(versionNumber);
    if (targetVersionNumber !== Number(resolvedHead.current_version_number) && String(resolvedHead.visibility) !== 'public' && String(resolvedHead.owner_user_id) !== String(userId || '')) {
      throw new AssetPermissionError('forbidden');
    }
    const version = includeContent
      ? await this.getAssetVersion(assetId, targetVersionNumber)
      : await this.getAssetVersionMetadata(assetId, targetVersionNumber);
    if (version === null) {
      throw new AssetNotFoundError(`Asset version ${assetId}:${targetVersionNumber} not found`);
    }
    const subscription = userId ? await this._findSubscriptionRow(assetId, userId) : null;
    return { head: resolvedHead, version, subscription };
  }

  async _getAssetDetailPayload({ assetId, assetType, userId, versionNumber, head = null }) {
    const { head: resolvedHead, version, subscription } = await this._getAssetContext({ assetId, assetType, userId, versionNumber, head });
    return typedAssetDetailPayloadFromRows({
      head: resolvedHead,
      version,
      subscription,
      viewerUserId: userId,
      includeVersionNumber: versionNumber !== null,
    });
  }

  async _getAssetContentPayload({ assetId, assetType, userId, versionNumber, head = null }) {
    const { head: resolvedHead, version } = await this._getAssetContext({ assetId, assetType, userId, versionNumber, includeContent: true, head });
    return typedAssetContentPayloadFromRows({ head: resolvedHead, version });
  }

  async _listTypedAssetSummaries({ assetType, userId, query, cursor, visibility, owner, extraFilters }) {
    const filters = ['h.asset_type = ?'];
    const bindings = [assetType];
    applyVisibilityOwnerFilters({ filters, bindings, userId, visibility, owner });
    applyAssetQueryFilters({ filters, bindings, query, assetType, extraFilters });

    const start = parseCursor(cursor);
    const sql = assetType === 'variant'
      ? `
        SELECT
          h.*,
          vd.variant_kind,
          vd.base_node_type,
          vd.service_class,
          vd.operator_class,
          u.name AS owner_display_name,
          s.subscribed_at,
          s.last_seen_version_number,
          v.created_by_user_id,
          v.change_summary,
          v.version_number
        FROM asset_heads h
        LEFT JOIN variant_details vd ON vd.asset_id = h.asset_id
        JOIN asset_versions v
          ON v.asset_id = h.asset_id AND v.version_number = h.current_version_number
        LEFT JOIN user u ON u.id = h.owner_user_id
        LEFT JOIN asset_subscriptions s ON s.asset_id = h.asset_id AND s.subscriber_user_id = ?
        WHERE ${filters.join(' AND ')}
        ORDER BY LOWER(h.name), h.asset_id
        LIMIT ? OFFSET ?
      `
      : `
        SELECT
          h.*,
          u.name AS owner_display_name,
          s.subscribed_at,
          s.last_seen_version_number,
          v.created_by_user_id,
          v.change_summary,
          v.version_number
        FROM asset_heads h
        JOIN asset_versions v
          ON v.asset_id = h.asset_id AND v.version_number = h.current_version_number
        LEFT JOIN user u ON u.id = h.owner_user_id
        LEFT JOIN asset_subscriptions s ON s.asset_id = h.asset_id AND s.subscriber_user_id = ?
        WHERE ${filters.join(' AND ')}
        ORDER BY LOWER(h.name), h.asset_id
        LIMIT ? OFFSET ?
      `;
    const result = await this._db.prepare(sql).bind(userId ? String(userId) : '', ...bindings, PAGE_SIZE + 1, start).all();
    const rows = Array.isArray(result.results) ? result.results : [];
    const hasMore = rows.length > PAGE_SIZE;
    const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    return {
      entries: items.map((row) => typedAssetSummaryPayloadFromRow(row, userId)),
      nextCursor: hasMore ? String(start + PAGE_SIZE) : null,
    };
  }

  async _listAssetVersions({ assetId, assetType, userId, cursor }) {
    const head = await this.getAssetById(assetId);
    if (head === null || String(head.asset_type) !== assetType) {
      throw new AssetNotFoundError(`Asset ${assetId} not found`);
    }
    ensureCanView(head, userId);

    const start = parseCursor(cursor);
    const result = await this._db.prepare(
      `SELECT asset_id, version_number, created_at, created_by_user_id, change_summary
       FROM asset_versions
       WHERE asset_id = ?
       ORDER BY version_number DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(String(assetId), PAGE_SIZE + 1, start)
      .all();
    const rows = Array.isArray(result.results) ? result.results : [];
    const hasMore = rows.length > PAGE_SIZE;
    const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    return {
      versions: items.map((row) => assetVersionSummaryFromRow(assetType, row)),
      nextCursor: hasMore ? String(start + PAGE_SIZE) : null,
    };
  }

  async _listAssetSubscribers({ assetId, assetType, userId, cursor }) {
    const head = await this.getAssetById(assetId);
    if (head === null || String(head.asset_type) !== assetType) {
      throw new AssetNotFoundError(`Asset ${assetId} not found`);
    }
    if (String(head.owner_user_id) !== String(userId || '')) {
      throw new AssetPermissionError('forbidden');
    }

    const start = parseCursor(cursor);
    const result = await this._db.prepare(
      `SELECT
         s.subscriber_user_id,
         s.subscribed_at,
         s.last_seen_version_number,
         u.name AS subscriber_name
       FROM asset_subscriptions s
       JOIN user u ON u.id = s.subscriber_user_id
       WHERE s.asset_id = ?
       ORDER BY LOWER(COALESCE(u.name, s.subscriber_user_id)), s.subscriber_user_id
       LIMIT ? OFFSET ?`,
    )
      .bind(String(assetId), PAGE_SIZE + 1, start)
      .all();
    const rows = Array.isArray(result.results) ? result.results : [];
    const hasMore = rows.length > PAGE_SIZE;
    const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    return {
      entries: items.map((row) => assetSubscriberFromRow(row)),
      nextCursor: hasMore ? String(start + PAGE_SIZE) : null,
    };
  }

  async _subscribeAsset({ assetId, assetType, userId }) {
    const head = await this.getAssetById(assetId, assetType);
    if (head === null || String(head.asset_type) !== assetType) {
      throw new AssetNotFoundError(`Asset ${assetId} not found`);
    }
    if (String(head.visibility) !== 'public' && String(head.owner_user_id) !== String(userId)) {
      throw new AssetPermissionError('forbidden');
    }
    const now = nowIso();
    await this._db.prepare(
      `INSERT INTO asset_subscriptions (asset_id, subscriber_user_id, subscribed_at, last_seen_version_number)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(asset_id, subscriber_user_id)
       DO UPDATE SET subscribed_at = excluded.subscribed_at, last_seen_version_number = excluded.last_seen_version_number`,
    )
      .bind(String(assetId), String(userId), now, Number(head.current_version_number))
      .run();
    return this._getAssetDetailPayload({ assetId, assetType, userId, versionNumber: null });
  }

  async _unsubscribeAsset({ assetId, assetType, userId }) {
    const head = await this.getAssetById(assetId, assetType);
    if (head === null || String(head.asset_type) !== assetType) {
      throw new AssetNotFoundError(`Asset ${assetId} not found`);
    }
    if (String(head.visibility) !== 'public' && String(head.owner_user_id) !== String(userId)) {
      throw new AssetPermissionError('forbidden');
    }
    await this._db.prepare(
      `DELETE FROM asset_subscriptions WHERE asset_id = ? AND subscriber_user_id = ?`,
    )
      .bind(String(assetId), String(userId))
      .run();
    return this._getAssetDetailPayload({ assetId, assetType, userId, versionNumber: null });
  }

  async _updateAssetVersionNote({ assetId, assetType, versionNumber, changeSummary, userId }) {
    const head = await this.getAssetById(assetId, assetType);
    if (head === null || String(head.asset_type) !== assetType) {
      throw new AssetNotFoundError(`Asset ${assetId} not found`);
    }
    if (String(head.owner_user_id) !== String(userId || '')) {
      throw new AssetPermissionError('forbidden');
    }
    const normalizedVersionNumber = normalizeVersionNumber(versionNumber);
    const existingVersion = await this.getAssetVersionMetadata(assetId, normalizedVersionNumber);
    if (existingVersion === null) {
      throw new AssetNotFoundError(`Asset version ${assetId}:${normalizedVersionNumber} not found`);
    }
    await this._db.prepare(
      `UPDATE asset_versions
       SET change_summary = ?
       WHERE asset_id = ? AND version_number = ?`,
    )
      .bind(normalizeChangeSummary(changeSummary), String(assetId), normalizedVersionNumber)
      .run();
    return this._getAssetDetailPayload({
      assetId,
      assetType,
      userId,
      versionNumber: normalizedVersionNumber,
    });
  }

  async _forkAsset({ assetId, assetType, payload, user }) {
    const source = await this._getAssetContentPayload({ assetId, assetType, userId: user.userId, versionNumber: null });
    const forkPayload = isPlainObject(payload) ? payload : {};
    if (assetType === 'variant') {
      const sourceRecord = source.record;
      return this.createVariant({
        payload: {
          record: {
            ...sourceRecord,
            variantId: stringOrDefault(forkPayload.variantId, crypto.randomUUID()),
            name: stringOrDefault(forkPayload.name, `${sourceRecord.name} Copy`),
          },
          visibility: stringOrDefault(forkPayload.visibility, 'private'),
          changeSummary: stringOrDefault(forkPayload.changeSummary, `Forked from ${assetId}`),
        },
        user,
      });
    }
    if (assetType === 'component') {
      const sourceRecord = source.record;
      return this.createComponent({
        payload: {
          record: {
            ...sourceRecord,
            componentId: stringOrDefault(forkPayload.componentId, crypto.randomUUID()),
            name: stringOrDefault(forkPayload.name, `${sourceRecord.name} Copy`),
            content: deepCloneJson(sourceRecord.content),
          },
          visibility: stringOrDefault(forkPayload.visibility, 'private'),
          changeSummary: stringOrDefault(forkPayload.changeSummary, `Forked from ${assetId}`),
        },
        user,
      });
    }
    const sourceRecord = source.record;
    return this.createModdingRecipe({
      payload: {
        record: {
          ...sourceRecord,
          recipeId: stringOrDefault(forkPayload.recipeId, crypto.randomUUID()),
          name: stringOrDefault(forkPayload.name, `${sourceRecord.name} Copy`),
          content: deepCloneJson(sourceRecord.content),
        },
        visibility: stringOrDefault(forkPayload.visibility, 'private'),
        changeSummary: stringOrDefault(forkPayload.changeSummary, `Forked from ${assetId}`),
      },
      user,
    });
  }

  async _updateAssetVisibility({ assetId, assetType, visibility, versionNumber, userId }) {
    const existing = await this._requireOwnedAsset({ assetId, assetType, userId });
    const expectedVersionNumber = normalizeOptionalVersionNumber(versionNumber);
    if (expectedVersionNumber !== null && expectedVersionNumber !== Number(existing.current_version_number)) {
      throw new AssetConflictError({
        assetId: String(existing.asset_id),
        assetType,
        versionNumber: Number(existing.current_version_number),
      });
    }
    await this._db.prepare(
      `UPDATE asset_heads
       SET visibility = ?,
           updated_at = ?
       WHERE asset_id = ?`,
    )
      .bind(normalizeVisibility(visibility), nowIso(), String(assetId))
      .run();
    return this._getAssetDetailPayload({ assetId, assetType, userId, versionNumber: null });
  }

  async updateVariantMeta({ variantId, payload, user }) {
    return this._updateAssetMeta({ assetId: variantId, assetType: 'variant', payload, userId: user.userId });
  }

  async updateComponentMeta({ componentId, payload, user }) {
    return this._updateAssetMeta({ assetId: componentId, assetType: 'component', payload, userId: user.userId });
  }

  async _updateAssetMeta({ assetId, assetType, payload, userId }) {
    // Metadata-only update: updates name/description/tags without creating a new version row.
    await this._requireOwnedAsset({ assetId, assetType, userId });
    const name = requireAssetName(payload.name, 'name is required');
    const description = optionalDescription(payload.description);
    const tags = normalizeTags(payload.tags);
    await this._db.prepare(
      `UPDATE asset_heads
       SET name = ?,
           description = ?,
           tags_json = ?,
           updated_at = ?
       WHERE asset_id = ?`,
    )
      .bind(name, description, JSON.stringify(tags), nowIso(), String(assetId))
      .run();
    return this._getAssetDetailPayload({ assetId, assetType, userId, versionNumber: null });
  }

  async _requireOwnedAsset({ assetId, assetType, userId }) {
    const existing = await this.getAssetById(assetId, assetType);
    if (existing === null || String(existing.asset_type) !== assetType) {
      throw new AssetNotFoundError(`Asset ${assetId} not found`);
    }
    if (String(existing.owner_user_id) !== String(userId)) {
      throw new AssetPermissionError('forbidden');
    }
    return existing;
  }

  async _insertAssetVersion({ assetId, versionNumber, contentJson, createdAt, createdByUserId, changeSummary }) {
    const compressedContent = await compressGzip(contentJson);
    await this._db.prepare(
      `INSERT INTO asset_versions (
         asset_id, version_number, content, created_at, created_by_user_id, change_summary
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        String(assetId),
        Number(versionNumber),
        compressedContent,
        String(createdAt),
        String(createdByUserId),
        nullableString(changeSummary),
      )
      .run();
  }

  async _upsertVariantDetails(assetId, details) {
    await this._db.prepare(
      `INSERT INTO variant_details (
         asset_id, variant_kind, base_node_type, service_class, operator_class
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(asset_id)
       DO UPDATE SET
         variant_kind = excluded.variant_kind,
         base_node_type = excluded.base_node_type,
         service_class = excluded.service_class,
         operator_class = excluded.operator_class`,
    )
      .bind(
        String(assetId),
        String(details.variantKind),
        String(details.baseNodeType),
        String(details.serviceClass),
        nullableString(details.operatorClass),
      )
      .run();
  }

  async _deleteVariantDetails(assetId) {
    await this._db.prepare('DELETE FROM variant_details WHERE asset_id = ?')
      .bind(String(assetId))
      .run();
  }

  async _findAssetHeadRow(assetId, { assetTypeHint = '' } = {}) {
    const row = assetTypeHint === 'variant'
      ? await this._db.prepare(
        `SELECT
           h.*,
           vd.variant_kind,
           vd.base_node_type,
           vd.service_class,
           vd.operator_class,
           u.name AS owner_display_name
         FROM asset_heads h
         JOIN asset_versions v
           ON v.asset_id = h.asset_id AND v.version_number = h.current_version_number
         LEFT JOIN variant_details vd ON vd.asset_id = h.asset_id
         LEFT JOIN user u ON u.id = h.owner_user_id
         WHERE h.asset_id = ?`,
      )
        .bind(String(assetId))
        .first()
      : await this._db.prepare(
        `SELECT
           h.*,
           u.name AS owner_display_name
        FROM asset_heads h
         JOIN asset_versions v
           ON v.asset_id = h.asset_id AND v.version_number = h.current_version_number
         LEFT JOIN user u ON u.id = h.owner_user_id
         WHERE h.asset_id = ?`,
      )
        .bind(String(assetId))
        .first();
    if (row === null) {
      return null;
    }
    if (assetTypeHint === 'variant') {
      return row;
    }
    return this._mergeVariantDetailsIntoRow(row);
  }

  async _findAssetVersionRow(assetId, versionNumber) {
    const row = await this._db.prepare(
      `SELECT asset_id, version_number, content, created_at, created_by_user_id, change_summary
       FROM asset_versions
       WHERE asset_id = ? AND version_number = ?`,
    )
      .bind(String(assetId), Number(versionNumber))
      .first();
    if (!row) {
      return null;
    }
    return this._inflateVersionRow(row);
  }

  async _findAssetVersionMetadataRow(assetId, versionNumber) {
    const row = await this._db.prepare(
      `SELECT asset_id, version_number, created_at, created_by_user_id, change_summary
       FROM asset_versions
       WHERE asset_id = ? AND version_number = ?`,
    )
      .bind(String(assetId), Number(versionNumber))
      .first();
    return row || null;
  }

  async _inflateVersionRow(row) {
    return {
      ...row,
      content: await decodeVersionContent(row.content),
    };
  }

  async getAssetById(assetId, assetTypeHint = '') {
    return this._findAssetHeadRow(assetId, { assetTypeHint });
  }

  async getAssetVersion(assetId, versionNumber) {
    return this._findAssetVersionRow(assetId, versionNumber);
  }

  async getAssetVersionMetadata(assetId, versionNumber) {
    return this._findAssetVersionMetadataRow(assetId, versionNumber);
  }

  async _findSubscriptionRow(assetId, userId) {
    const row = await this._db.prepare(
      `SELECT asset_id, subscriber_user_id, subscribed_at, last_seen_version_number
       FROM asset_subscriptions WHERE asset_id = ? AND subscriber_user_id = ?`,
    )
      .bind(String(assetId), String(userId))
      .first();
    return row === null ? null : row;
  }

  async _hasVariantDetailsTable() {
    if (this._hasVariantDetailsTableCached !== null) {
      return this._hasVariantDetailsTableCached;
    }
    const row = await this._db.prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = 'variant_details'
       LIMIT 1`,
    ).first();
    const hasTable = row !== null;
    this._hasVariantDetailsTableCached = hasTable;
    return hasTable;
  }

  async _findVariantDetailsRow(assetId) {
    if (!await this._hasVariantDetailsTable()) {
      return null;
    }
    const row = await this._db.prepare(
      `SELECT asset_id, variant_kind, base_node_type, service_class, operator_class
       FROM variant_details
       WHERE asset_id = ?`,
    )
      .bind(String(assetId))
      .first();
    return row === null ? null : row;
  }

  async _findVariantDetailsRows(assetIds) {
    if (assetIds.length === 0 || !await this._hasVariantDetailsTable()) {
      return new Map();
    }
    const placeholders = assetIds.map(() => '?').join(', ');
    const result = await this._db.prepare(
      `SELECT asset_id, variant_kind, base_node_type, service_class, operator_class
       FROM variant_details
       WHERE asset_id IN (${placeholders})`,
    )
      .bind(...assetIds)
      .all();
    const rows = Array.isArray(result.results) ? result.results : [];
    const byAssetId = new Map();
    for (const row of rows) {
      byAssetId.set(String(row.asset_id), row);
    }
    return byAssetId;
  }

  async _mergeVariantDetailsIntoRow(row) {
    if (String(row.asset_type) !== 'variant') {
      return row;
    }
    const details = await this._findVariantDetailsRow(String(row.asset_id));
    if (details === null) {
      return row;
    }
    return {
      ...row,
      variant_kind: details.variant_kind,
      base_node_type: details.base_node_type,
      service_class: details.service_class,
      operator_class: details.operator_class,
    };
  }

  async _mergeVariantDetailsIntoRows(rows) {
    const variantAssetIds = [];
    for (const row of rows) {
      if (String(row.asset_type) === 'variant') {
        variantAssetIds.push(String(row.asset_id));
      }
    }
    const detailsByAssetId = await this._findVariantDetailsRows(variantAssetIds);
    return rows.map((row) => {
      if (String(row.asset_type) !== 'variant') {
        return row;
      }
      const details = detailsByAssetId.get(String(row.asset_id));
      if (details === undefined) {
        return row;
      }
      return {
        ...row,
        variant_kind: details.variant_kind,
        base_node_type: details.base_node_type,
        service_class: details.service_class,
        operator_class: details.operator_class,
      };
    });
  }

  async hasAssets(userId) {
    const row = await this._db.prepare(
      `SELECT (SELECT COUNT(*) FROM asset_heads WHERE owner_user_id = ?)
        + (SELECT COUNT(*) FROM cloud_assets WHERE owner_user_id = ?) AS count`,
    )
      .bind(String(userId), String(userId))
      .first();
    return Number(row?.count || 0) > 0;
  }

  async _ensureSiteSettingsRow() {
    await this._db.prepare(
      `INSERT INTO site_settings (id, allow_user_registration, updated_at, updated_by_user_id)
       VALUES (1, 0, ?, NULL)
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(nowIso())
      .run();
  }
}

export { AssetConflictError } from './legacy/conflict_error.js';
export { AssetNotFoundError, AssetPermissionError, AssetValidationError } from './legacy/errors.js';
