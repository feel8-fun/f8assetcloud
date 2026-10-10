import { decompressGzip, isPlainObject, nowIso, nullableString, stringOrDefault } from '../utils.js';
import { hasSubscription, normalizeChangeSummary, normalizeDbTimestamp, normalizeIsoString, normalizeOptionalVersionNumber, normalizeTags, normalizeVisibility, nullableNumber, optionalAssetField, optionalDescription, rejectLocalPathFields, requireAssetField, requireAssetIdentifier, requireAssetName, requireNonEmptyString, stableJson } from './validation.js';
import { AssetValidationError } from './errors.js';
import { deepCloneJson, parseJsonArray, parseJsonObject, toBinaryContent } from './serialization.js';

const COMPONENT_SCHEMA_VERSION = 'f8studio-session/1';

const MODDING_RECIPE_SCHEMA_VERSION = 'f8moddingrecipe/1';

export function normalizeVariantCreatePayload(payload, user) {
  const record = normalizeVariantRecord(payload.record, { expectedVariantId: '' });
  const timestamp = nowIso();
  const createdAt = normalizeIsoString(record.createdAt, timestamp);
  const updatedAt = timestamp;
  return {
    assetId: record.variantId,
    assetType: 'variant',
    ownerUserId: String(user.userId),
    visibility: normalizeVisibility(payload.visibility),
    versionNumber: null,
    name: record.name,
    description: record.description,
    tags: record.tags,
    createdAt,
    updatedAt,
    changeSummary: normalizeChangeSummary(payload.changeSummary),
    variantDetails: {
      variantKind: record.kind,
      baseNodeType: record.baseNodeType,
      serviceClass: record.serviceClass,
      operatorClass: record.operatorClass,
    },
    contentJson: stableJson(record.spec),
  };
}

export function normalizeVariantUpdatePayload(payload, existing, user) {
  const record = normalizeVariantRecord(payload.record, { expectedVariantId: String(existing.asset_id) });
  const timestamp = nowIso();
  return {
    assetId: String(existing.asset_id),
    assetType: 'variant',
    ownerUserId: String(user.userId),
    visibility: normalizeVisibility(payload.visibility ?? existing.visibility),
    versionNumber: normalizeOptionalVersionNumber(payload.versionNumber),
    name: record.name,
    description: record.description,
    tags: record.tags,
    createdAt: String(existing.created_at),
    updatedAt: timestamp,
    changeSummary: normalizeChangeSummary(payload.changeSummary),
    variantDetails: {
      variantKind: record.kind,
      baseNodeType: record.baseNodeType,
      serviceClass: record.serviceClass,
      operatorClass: record.operatorClass,
    },
    contentJson: stableJson(record.spec),
  };
}

export function normalizeComponentCreatePayload(payload, user) {
  const record = normalizeComponentRecord(payload.record, { expectedComponentId: '' });
  const timestamp = nowIso();
  const createdAt = normalizeIsoString(record.createdAt, timestamp);
  const updatedAt = timestamp;
  return {
    assetId: record.componentId,
    assetType: 'component',
    ownerUserId: String(user.userId),
    visibility: normalizeVisibility(payload.visibility),
    versionNumber: null,
    name: record.name,
    description: record.description,
    tags: record.tags,
    createdAt,
    updatedAt,
    changeSummary: normalizeChangeSummary(payload.changeSummary),
    contentJson: stableJson(record.content),
  };
}

export function normalizeComponentUpdatePayload(payload, existing, user) {
  const record = normalizeComponentRecord(payload.record, { expectedComponentId: String(existing.asset_id) });
  const timestamp = nowIso();
  return {
    assetId: String(existing.asset_id),
    assetType: 'component',
    ownerUserId: String(user.userId),
    visibility: normalizeVisibility(payload.visibility ?? existing.visibility),
    versionNumber: normalizeOptionalVersionNumber(payload.versionNumber),
    name: record.name,
    description: record.description,
    tags: record.tags,
    createdAt: String(existing.created_at),
    updatedAt: timestamp,
    changeSummary: normalizeChangeSummary(payload.changeSummary),
    contentJson: stableJson(record.content),
  };
}

export function normalizeModdingRecipeCreatePayload(payload, user) {
  const record = normalizeModdingRecipeRecord(payload.record, { expectedRecipeId: '' });
  const timestamp = nowIso();
  const createdAt = normalizeIsoString(record.createdAt, timestamp);
  const updatedAt = timestamp;
  return {
    assetId: record.recipeId,
    assetType: 'modding_recipe',
    ownerUserId: String(user.userId),
    visibility: normalizeVisibility(payload.visibility),
    versionNumber: null,
    name: record.name,
    description: record.description,
    tags: record.tags,
    createdAt,
    updatedAt,
    changeSummary: normalizeChangeSummary(payload.changeSummary),
    contentJson: stableJson(record.content),
  };
}

export function normalizeModdingRecipeUpdatePayload(payload, existing, user) {
  const record = normalizeModdingRecipeRecord(payload.record, { expectedRecipeId: String(existing.asset_id) });
  const timestamp = nowIso();
  return {
    assetId: String(existing.asset_id),
    assetType: 'modding_recipe',
    ownerUserId: String(user.userId),
    visibility: normalizeVisibility(payload.visibility ?? existing.visibility),
    versionNumber: normalizeOptionalVersionNumber(payload.versionNumber),
    name: record.name,
    description: record.description,
    tags: record.tags,
    createdAt: String(existing.created_at),
    updatedAt: timestamp,
    changeSummary: normalizeChangeSummary(payload.changeSummary),
    contentJson: stableJson(record.content),
  };
}

function normalizeVariantRecord(record, { expectedVariantId }) {
  if (!isPlainObject(record)) {
    throw new AssetValidationError('record is required');
  }
  const variantId = requireAssetIdentifier(record.variantId, 'record.variantId is required');
  if (expectedVariantId && variantId !== expectedVariantId) {
    throw new AssetValidationError('record.variantId must match the request path');
  }
  const kind = requireAssetField(record.kind, 'record.kind is required');
  const baseNodeType = requireAssetField(record.baseNodeType, 'record.baseNodeType is required');
  const serviceClass = requireAssetField(record.serviceClass, 'record.serviceClass is required');
  const name = requireAssetName(record.name, 'record.name is required');
  if (!isPlainObject(record.spec)) {
    throw new AssetValidationError('record.spec must be a JSON object');
  }
  return {
    variantId,
    kind,
    baseNodeType,
    serviceClass,
    operatorClass: optionalAssetField(record.operatorClass),
    name,
    description: optionalDescription(record.description),
    tags: normalizeTags(record.tags),
    spec: deepCloneJson(record.spec),
    createdAt: normalizeIsoString(record.createdAt, ''),
    updatedAt: normalizeIsoString(record.updatedAt, ''),
  };
}

function normalizeComponentRecord(record, { expectedComponentId }) {
  if (!isPlainObject(record)) {
    throw new AssetValidationError('record is required');
  }
  if (Object.hasOwn(record, 'schemaVersion')) {
    throw new AssetValidationError('record.schemaVersion is not allowed; use record.content.schemaVersion');
  }
  const componentId = requireAssetIdentifier(record.componentId, 'record.componentId is required');
  if (expectedComponentId && componentId !== expectedComponentId) {
    throw new AssetValidationError('record.componentId must match the request path');
  }
  if (!isPlainObject(record.content)) {
    throw new AssetValidationError('record.content must be a JSON object');
  }
  const contentSchemaVersion = requireNonEmptyString(record.content.schemaVersion, 'record.content.schemaVersion is required');
  if (contentSchemaVersion !== COMPONENT_SCHEMA_VERSION) {
    throw new AssetValidationError(`record.content.schemaVersion must be ${COMPONENT_SCHEMA_VERSION}`);
  }
  if (!isPlainObject(record.content.layout)) {
    throw new AssetValidationError('record.content.layout must be a JSON object');
  }
  return {
    componentId,
    name: requireAssetName(record.name, 'record.name is required'),
    description: optionalDescription(record.description),
    tags: normalizeTags(record.tags),
    content: deepCloneJson(record.content),
    createdAt: normalizeIsoString(record.createdAt, ''),
    updatedAt: normalizeIsoString(record.updatedAt, ''),
  };
}

function normalizeModdingRecipeRecord(record, { expectedRecipeId }) {
  if (!isPlainObject(record)) {
    throw new AssetValidationError('record is required');
  }
  if (Object.hasOwn(record, 'schemaVersion')) {
    throw new AssetValidationError('record.schemaVersion is not allowed; use record.content.schemaVersion');
  }
  if (Object.hasOwn(record, 'lastTargetPath')) {
    throw new AssetValidationError('record.lastTargetPath is local-only and cannot be published');
  }
  const recipeId = requireAssetIdentifier(record.recipeId, 'record.recipeId is required');
  if (expectedRecipeId && recipeId !== expectedRecipeId) {
    throw new AssetValidationError('record.recipeId must match the request path');
  }
  if (!isPlainObject(record.content)) {
    throw new AssetValidationError('record.content must be a JSON object');
  }
  const content = normalizeModdingRecipeContentPayload(record.content);
  rejectLocalPathFields(content);
  return {
    recipeId,
    name: requireAssetName(record.name, 'record.name is required'),
    description: optionalDescription(record.description),
    tags: normalizeTags(record.tags),
    content,
    createdAt: normalizeIsoString(record.createdAt, ''),
    updatedAt: normalizeIsoString(record.updatedAt, ''),
  };
}

export function typedAssetSummaryPayloadFromRow(row, viewerUserId) {
  if (String(row.asset_type) === 'variant') {
    return variantSummaryPayloadFromRow(row, viewerUserId);
  }
  if (String(row.asset_type) === 'modding_recipe') {
    return moddingRecipeSummaryPayloadFromRow(row, viewerUserId);
  }
  return componentSummaryPayloadFromRow(row, viewerUserId);
}

export function typedAssetDetailPayloadFromRows({ head, version, subscription, viewerUserId, includeVersionNumber }) {
  if (String(head.asset_type) === 'variant') {
    return variantDetailPayloadFromRows({ head, version, subscription, viewerUserId, includeVersionNumber });
  }
  if (String(head.asset_type) === 'modding_recipe') {
    return moddingRecipeDetailPayloadFromRows({ head, version, subscription, viewerUserId, includeVersionNumber });
  }
  return componentDetailPayloadFromRows({ head, version, subscription, viewerUserId, includeVersionNumber });
}

export function typedAssetContentPayloadFromRows({ head, version }) {
  if (String(head.asset_type) === 'variant') {
    return variantContentPayloadFromRows({ head, version });
  }
  if (String(head.asset_type) === 'modding_recipe') {
    return moddingRecipeContentPayloadFromRows({ head, version });
  }
  return componentContentPayloadFromRows({ head, version });
}

function variantSummaryPayloadFromRow(row, viewerUserId) {
  return {
    ...genericTypedAssetPayload(row, viewerUserId),
    variantId: String(row.asset_id),
    variantKind: stringOrDefault(row.variant_kind, ''),
    baseNodeType: stringOrDefault(row.base_node_type, ''),
    serviceClass: stringOrDefault(row.service_class, ''),
    operatorClass: nullableString(row.operator_class),
    hasContent: true,
  };
}

function variantDetailPayloadFromRows({ head, version, subscription, viewerUserId, includeVersionNumber }) {
  const payload = {
    ...variantSummaryPayloadFromRow(
      {
        ...head,
        ...(subscription || {}),
        created_by_user_id: version.created_by_user_id,
        change_summary: version.change_summary,
        version_number: version.version_number,
      },
      viewerUserId,
    ),
    versionCreatedAt: normalizeDbTimestamp(version.created_at),
    createdByUserId: String(version.created_by_user_id),
  };
  if (includeVersionNumber) {
    payload.versionNumber = Number(version.version_number);
  }
  return payload;
}

function variantContentPayloadFromRows({ head, version }) {
  return {
    variantId: String(head.asset_id),
    assetType: 'variant',
    versionNumber: Number(version.version_number),
    record: parseVariantRecord(version.content, { head, version }),
  };
}

function componentSummaryPayloadFromRow(row, viewerUserId) {
  return {
    ...genericTypedAssetPayload(row, viewerUserId),
    componentId: String(row.asset_id),
    hasContent: true,
  };
}

function componentDetailPayloadFromRows({ head, version, subscription, viewerUserId, includeVersionNumber }) {
  const payload = {
    ...componentSummaryPayloadFromRow(
      {
        ...head,
        ...(subscription || {}),
        created_by_user_id: version.created_by_user_id,
        change_summary: version.change_summary,
        version_number: version.version_number,
      },
      viewerUserId,
    ),
    versionCreatedAt: normalizeDbTimestamp(version.created_at),
    createdByUserId: String(version.created_by_user_id),
  };
  if (includeVersionNumber) {
    payload.versionNumber = Number(version.version_number);
  }
  return payload;
}

function componentContentPayloadFromRows({ head, version }) {
  return {
    componentId: String(head.asset_id),
    assetType: 'component',
    versionNumber: Number(version.version_number),
    record: parseComponentRecord(version.content, { head, version }),
  };
}

function moddingRecipeSummaryPayloadFromRow(row, viewerUserId) {
  return {
    ...genericTypedAssetPayload(row, viewerUserId),
    recipeId: String(row.asset_id),
    hasContent: true,
  };
}

function moddingRecipeDetailPayloadFromRows({ head, version, subscription, viewerUserId, includeVersionNumber }) {
  const payload = {
    ...moddingRecipeSummaryPayloadFromRow(
      {
        ...head,
        ...(subscription || {}),
        created_by_user_id: version.created_by_user_id,
        change_summary: version.change_summary,
        version_number: version.version_number,
      },
      viewerUserId,
    ),
    versionCreatedAt: normalizeDbTimestamp(version.created_at),
    createdByUserId: String(version.created_by_user_id),
  };
  if (includeVersionNumber) {
    payload.versionNumber = Number(version.version_number);
  }
  return payload;
}

function moddingRecipeContentPayloadFromRows({ head, version }) {
  return {
    recipeId: String(head.asset_id),
    assetType: 'modding_recipe',
    versionNumber: Number(version.version_number),
    record: parseModdingRecipeRecord(version.content, { head, version }),
  };
}

function genericTypedAssetPayload(row, viewerUserId) {
  const isOwner = String(row.owner_user_id) === String(viewerUserId || '');
  const isSubscribed = hasSubscription(row);
  return {
    assetType: String(row.asset_type),
    ownerUserId: String(row.owner_user_id),
    ownerDisplayName: nullableString(row.owner_display_name),
    visibility: String(row.visibility),
    versionNumber: Number(row.version_number ?? row.current_version_number),
    changeSummary: nullableString(row.change_summary),
    name: String(row.name),
    description: String(row.description),
    tags: normalizeTags(parseJsonArray(row.tags_json)),
    createdAt: normalizeDbTimestamp(row.created_at),
    updatedAt: normalizeDbTimestamp(row.updated_at),
    isOwner,
    subscribed: isSubscribed,
    editable: isOwner,
    subscription: isSubscribed
      ? {
        subscribedAt: normalizeDbTimestamp(row.subscribed_at),
        lastSeenVersionNumber: nullableNumber(row.last_seen_version_number),
      }
      : null,
  };
}

export function assetSubscriberFromRow(row) {
  return {
    userId: String(row.subscriber_user_id),
    name: stringOrDefault(row.subscriber_name, String(row.subscriber_user_id || '')),
    subscribedAt: normalizeDbTimestamp(row.subscribed_at),
    lastSeenVersionNumber: nullableNumber(row.last_seen_version_number),
  };
}

export function adminAssetDetailFromRows({ head, version }) {
  const summary = adminAssetSummaryFromRow({
    ...head,
    created_by_user_id: version.created_by_user_id,
    change_summary: version.change_summary,
    version_number: version.version_number,
  });
  if (String(head.asset_type) === 'variant') {
    return {
      ...summary,
      record: parseVariantRecord(version.content, { head, version }),
    };
  }
  if (String(head.asset_type) === 'modding_recipe') {
    return {
      ...summary,
      record: parseModdingRecipeRecord(version.content, { head, version }),
    };
  }
  return {
    ...summary,
    record: parseComponentRecord(version.content, { head, version }),
  };
}

export function adminAssetSummaryFromRow(row) {
  const base = genericAssetSummary(row);
  if (String(row.asset_type) === 'variant') {
    return {
      ...base,
      variantKind: stringOrDefault(row.variant_kind, ''),
      baseNodeType: stringOrDefault(row.base_node_type, ''),
      serviceClass: stringOrDefault(row.service_class, ''),
      operatorClass: nullableString(row.operator_class),
    };
  }
  return base;
}

export function siteSettingsPayloadFromRow(row) {
  return {
    allowUserRegistration: Number(row?.allow_user_registration ?? 0) !== 0,
    updatedAt: normalizeDbTimestamp(row?.updated_at),
    updatedByUserId: nullableString(row?.updated_by_user_id),
  };
}

function genericAssetSummary(row) {
  return {
    assetId: String(row.asset_id),
    assetType: String(row.asset_type),
    ownerUserId: String(row.owner_user_id),
    ownerDisplayName: nullableString(row.owner_display_name),
    visibility: String(row.visibility),
    versionNumber: Number(row.version_number ?? row.current_version_number),
    changeSummary: nullableString(row.change_summary),
    name: String(row.name),
    description: String(row.description),
    tags: normalizeTags(parseJsonArray(row.tags_json)),
    createdAt: normalizeDbTimestamp(row.created_at),
    updatedAt: normalizeDbTimestamp(row.updated_at),
  };
}

export function assetVersionSummaryFromRow(assetType, row) {
  const summary = {
    assetType,
    versionNumber: Number(row.version_number),
    createdAt: normalizeDbTimestamp(row.created_at),
    createdByUserId: String(row.created_by_user_id),
    changeSummary: nullableString(row.change_summary),
  };
  if (assetType === 'variant') {
    return { variantId: String(row.asset_id), ...summary };
  }
  if (assetType === 'modding_recipe') {
    return { recipeId: String(row.asset_id), ...summary };
  }
  return { componentId: String(row.asset_id), ...summary };
}

function parseVariantRecord(content, { head = null, version = null } = {}) {
  const specPayload = normalizeVariantContentPayload(parseJsonObject(content));
  const variantId = stringOrDefault(head?.asset_id, '');
  const createdAt = normalizeDbTimestamp(head?.created_at) || normalizeDbTimestamp(version?.created_at);
  const updatedAt = normalizeDbTimestamp(version?.created_at) || normalizeDbTimestamp(head?.updated_at) || createdAt;
  return {
    variantId,
    kind: stringOrDefault(head?.variant_kind, ''),
    baseNodeType: stringOrDefault(head?.base_node_type, ''),
    serviceClass: stringOrDefault(head?.service_class, ''),
    operatorClass: nullableString(head?.operator_class),
    name: stringOrDefault(head?.name, variantId),
    description: stringOrDefault(head?.description, ''),
    tags: normalizeTags(parseJsonArray(head?.tags_json)),
    spec: specPayload,
    createdAt,
    updatedAt,
  };
}

function parseComponentRecord(content, { head = null, version = null } = {}) {
  const contentPayload = normalizeComponentContentPayload(parseJsonObject(content));
  const componentId = stringOrDefault(head?.asset_id, '');
  const createdAt = normalizeDbTimestamp(head?.created_at) || normalizeDbTimestamp(version?.created_at);
  const updatedAt = normalizeDbTimestamp(version?.created_at) || normalizeDbTimestamp(head?.updated_at) || createdAt;
  return {
    componentId,
    name: stringOrDefault(head?.name, componentId),
    description: stringOrDefault(head?.description, ''),
    tags: normalizeTags(parseJsonArray(head?.tags_json)),
    content: contentPayload,
    createdAt,
    updatedAt,
  };
}

function parseModdingRecipeRecord(content, { head = null, version = null } = {}) {
  const contentPayload = normalizeModdingRecipeContentPayload(parseJsonObject(content));
  rejectLocalPathFields(contentPayload);
  const recipeId = stringOrDefault(head?.asset_id, '');
  const createdAt = normalizeDbTimestamp(head?.created_at) || normalizeDbTimestamp(version?.created_at);
  const updatedAt = normalizeDbTimestamp(version?.created_at) || normalizeDbTimestamp(head?.updated_at) || createdAt;
  return {
    recipeId,
    name: stringOrDefault(head?.name, recipeId),
    description: stringOrDefault(head?.description, ''),
    tags: normalizeTags(parseJsonArray(head?.tags_json)),
    content: contentPayload,
    createdAt,
    updatedAt,
  };
}

function normalizeVariantSpecPayload(spec) {
  if (!isPlainObject(spec)) {
    throw new AssetValidationError('variant version payload must be a JSON object');
  }
  return deepCloneJson(spec);
}

function normalizeVariantContentPayload(content) {
  if (!isPlainObject(content)) {
    throw new AssetValidationError('stored variant content must be the raw spec JSON object');
  }
  if (looksLikeStoredRecordEnvelope(content) || looksLikeStoredVariantRecord(content)) {
    throw new AssetValidationError('stored variant content must be the raw spec JSON object without record or envelope metadata');
  }
  return normalizeVariantSpecPayload(content);
}

function normalizeComponentContentPayload(content) {
  if (!isPlainObject(content)) {
    throw new AssetValidationError(`stored component content must be the canonical session payload { schemaVersion, layout }`);
  }
  if (looksLikeStoredRecordEnvelope(content) || looksLikeStoredComponentRecord(content)) {
    throw new AssetValidationError(`stored component content must be the canonical session payload { schemaVersion, layout }`);
  }
  const schemaVersion = requireNonEmptyString(content.schemaVersion, 'component version payload schemaVersion is required');
  if (schemaVersion !== COMPONENT_SCHEMA_VERSION) {
    throw new AssetValidationError(`component version payload schemaVersion must be ${COMPONENT_SCHEMA_VERSION}`);
  }
  if (!isPlainObject(content.layout)) {
    throw new AssetValidationError('component version payload layout must be a JSON object');
  }
  return deepCloneJson(content);
}

function normalizeModdingRecipeContentPayload(content) {
  if (!isPlainObject(content)) {
    throw new AssetValidationError(`modding recipe payload must be the canonical recipe payload { schemaVersion, engine }`);
  }
  if (looksLikeStoredRecordEnvelope(content) || looksLikeStoredModdingRecipeRecord(content)) {
    throw new AssetValidationError(`modding recipe payload must be the canonical recipe payload without record or envelope metadata`);
  }
  const schemaVersion = requireNonEmptyString(content.schemaVersion, 'modding recipe schemaVersion is required');
  if (schemaVersion !== MODDING_RECIPE_SCHEMA_VERSION) {
    throw new AssetValidationError(`modding recipe schemaVersion must be ${MODDING_RECIPE_SCHEMA_VERSION}`);
  }
  requireNonEmptyString(content.engine, 'modding recipe engine is required');
  if (Object.hasOwn(content, 'lastTargetPath')) {
    throw new AssetValidationError('modding recipe lastTargetPath is local-only and cannot be published');
  }
  return deepCloneJson(content);
}

export async function decodeVersionContent(value) {
  if (value === null || value === undefined) {
    throw new AssetValidationError('stored version content is missing');
  }
  if (typeof value === 'string') {
    return parseJsonObject(value, 'stored version content must be a JSON object');
  }
  try {
    const binaryValue = toBinaryContent(value);
    if (binaryValue !== null) {
      try {
        return parseJsonObject(await decompressGzip(binaryValue), 'stored version content must be a JSON object');
      } catch (gzipError) {
        throw new AssetValidationError('stored version content must be valid gzip-compressed JSON');
      }
    }
    if (value instanceof Uint8Array) {
      return parseJsonObject(new TextDecoder().decode(value), 'stored version content must be a JSON object');
    }
    if (ArrayBuffer.isView(value)) {
      return parseJsonObject(new TextDecoder().decode(value), 'stored version content must be a JSON object');
    }
    if (value instanceof ArrayBuffer) {
      return parseJsonObject(new TextDecoder().decode(new Uint8Array(value)), 'stored version content must be a JSON object');
    }
    return parseJsonObject(String(value), 'stored version content must be a JSON object');
  } catch (decodeError) {
    if (decodeError instanceof AssetValidationError) {
      throw decodeError;
    }
    console.error('decodeVersionContent: failed to decode version content', decodeError);
    throw new AssetValidationError('stored version content must be a JSON object');
  }
}

function looksLikeStoredRecordEnvelope(payload) {
  return isPlainObject(payload) && isPlainObject(payload.record);
}

function looksLikeStoredVariantRecord(payload) {
  return isPlainObject(payload)
    && Object.hasOwn(payload, 'variantId')
    && isPlainObject(payload.spec);
}

function looksLikeStoredComponentRecord(payload) {
  return isPlainObject(payload)
    && Object.hasOwn(payload, 'componentId')
    && isPlainObject(payload.content);
}

function looksLikeStoredModdingRecipeRecord(payload) {
  return isPlainObject(payload)
    && Object.hasOwn(payload, 'recipeId')
    && isPlainObject(payload.content);
}
