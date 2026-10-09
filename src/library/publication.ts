import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../../contracts/publication.gen.json' with { type: 'json' };
import type { Publication, JsonValue, F8ServiceSpec, F8OperatorSpec, F8StateSpec } from '../../contracts/publication.gen.ts';
import { CloudError } from './contracts.ts';

const ajv = new Ajv2020.default({ strict: false, useDefaults: true, allErrors: true });
const stateAjv = new Ajv2020.default({ strict: false });
function stateSchema(schema: F8StateSpec['valueSchema']): Record<string, unknown> {
  if (schema.type === 'any') return {};
  if (schema.type === 'array') return {...schema,items:stateSchema(schema.items)};
  if (schema.type === 'object') return {...schema,properties:Object.fromEntries(Object.entries(schema.properties).map(([key,value])=>[key,stateSchema(value)]))};
  return {...schema};
}
const validators = {
  graph: ajv.compile<Publication>({ $ref: '#/$defs/GraphPublication', $defs: schema.$defs }),
  component: ajv.compile<Publication>({ $ref: '#/$defs/ComponentPublication', $defs: schema.$defs }),
};
const encoder = new TextEncoder();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function tree(value: JsonValue): JsonValue {
  if (value === null) return ['null'];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new CloudError(422, 'invalid_number', 'Publication numbers must be finite and portable');
    const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value === 0 ? 0 : value);
    return ['number', Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')];
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new CloudError(422, 'invalid_unicode', 'Publication strings must be valid Unicode');
    return ['string', value];
  }
  if (Array.isArray(value)) return ['array', value.map(tree)];
  const object = value as Readonly<Record<string, JsonValue>>;
  // Python sorts Unicode code points, while JS normally sorts UTF-16 units.
  return ['object', Object.keys(object).sort((a, b) => {
    const aa = Array.from(a, (c) => c.codePointAt(0)!); const bb = Array.from(b, (c) => c.codePointAt(0)!);
    for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
    return aa.length - bb.length;
  }).map((key) => [key, tree(object[key]!)])];
}
export async function hashValue(value: unknown): Promise<string> {
  const bytes = encoder.encode(JSON.stringify(['f8publication-hash/1', tree(value as JsonValue)]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function publicationHash(publication: Publication): Promise<string> {
  const content = structuredClone(publication.content);
  const manifest = structuredClone(publication.manifest);
  const normalized: Record<string, unknown> = { ...content };
  delete normalized.metadata;
  normalized.connections = [...content.connections!].sort((a, b) => compare(a.edgeId, b.edgeId));
  normalized.presentation = { ...content.presentation, layout: [...content.presentation!.layout!].sort((a, b) => compare(a.nodeId, b.nodeId)) };
  if ('hostBindings' in content) {
    normalized.hostBindings = [...content.hostBindings!].sort((a, b) => compare(a.bindingId, b.bindingId));
    normalized.endpoints = [...content.endpoints!].sort((a, b) => compare(a.endpointId, b.endpointId));
  }
  const dependencies = [...manifest.dependencies].sort((a, b) => compare(a.extensionId, b.extensionId)).map((d) => ({ ...d,
    compatibleVersions: [...d.compatibleVersions!].sort(compare), serviceClasses: [...d.serviceClasses!].sort(compare),
    protocolVersions: [...d.protocolVersions!].sort(compare), capabilities: [...d.capabilities!].sort(compare),
    operators: [...d.operators!].sort((a, b) => compare(a.serviceClass, b.serviceClass) || compare(a.operatorClass, b.operatorClass)),
  }));
  return hashValue({ hashProfile: 'f8publication-hash/1', manifest: { ...manifest, dependencies }, content: normalized });
}
export async function validatePublication(value: unknown): Promise<Publication> {
  const candidate = structuredClone(value);
  if (typeof candidate !== 'object' || candidate === null || !('kind' in candidate) ||
    (candidate.kind !== 'graph' && candidate.kind !== 'component'))
    throw new CloudError(422, 'unsupported_content', 'Expected f8publication/1; legacy Cloud content requires explicit conversion');
  const validate = validators[candidate.kind];
  if (!validate(candidate)) throw new CloudError(422, 'invalid_publication', ajv.errorsText(validate.errors));
  const { manifest, content } = candidate;
  if (manifest.kind !== candidate.kind || manifest.contentFormat !== content.format ||
    manifest.contentVersion !== content.formatVersion || !manifest.license.trim() ||
    (candidate.kind === 'graph' && content.formatVersion !== 4))
    throw new CloudError(422, 'invalid_manifest', 'Manifest format, kind, version and explicit license must match current content');
  if ((manifest.source.assetId == null) !== (manifest.source.assetVersion == null) ||
    (manifest.source.assetVersion != null && manifest.source.assetVersion < 1) ||
    (manifest.source.repositoryUrl != null && !manifest.source.repositoryUrl.startsWith('https://')))
    throw new CloudError(422, 'invalid_source', 'Publication source requires an HTTPS registry and fixed version');
  const deps = manifest.dependencies;
  if (new Set(deps.map((d) => d.extensionId)).size !== deps.length || deps.some((d) => !d.extensionId.trim()))
    throw new CloudError(422, 'invalid_dependencies', 'Extension IDs must be nonempty and unique');
  const services = content.definitions.services!; const operators = content.definitions.operators!;
  for (const spec of Object.values(services)) if (!deps.some((d) => d.serviceClasses!.includes(spec.serviceClass)))
    throw new CloudError(422, 'missing_dependency', `No extension ownership declared for ${spec.serviceClass}`);
  for (const spec of Object.values(operators)) if (!deps.some((d) => d.operators!.some((o) => o.serviceClass === spec.serviceClass && o.operatorClass === spec.operatorClass)))
    throw new CloudError(422, 'missing_dependency', `No extension ownership declared for ${spec.serviceClass}/${spec.operatorClass}`);
  const nodes = new Map<string, { spec: F8ServiceSpec | F8OperatorSpec; enabled: boolean; portIds: Readonly<Record<string, string>> }>();
  const hosts = new Map<string, string>(Object.entries(content.services).map(([id,node])=>[id,services[node.definitionRef]?.serviceClass ?? '']));
  if (candidate.kind === 'component') {
    for (const host of candidate.content.hostBindings!) {
      if (hosts.has(host.bindingId) || Object.hasOwn(content.operators,host.bindingId) || services[host.definitionRef]?.serviceClass !== host.serviceClass)
        throw new CloudError(422,'invalid_host','External host binding must have a unique identity and matching embedded definition');
      hosts.set(host.bindingId,host.serviceClass);
    }
  }
  for (const [id, node] of [...Object.entries(content.services), ...Object.entries(content.operators)]) {
    const operator = content.operators[id];
    const spec = operator ? operators[node.definitionRef] : services[node.definitionRef];
    if (!spec || node.nodeId !== id || nodes.has(id)) throw new CloudError(422, 'invalid_definition', `Invalid node or definition reference: ${id}`);
    if (operator && hosts.get(operator.serviceId) !== spec.serviceClass)
      throw new CloudError(422,'invalid_host',`Operator ${id} requires a matching service or external host`);
    const serviceEnabled = !operator || content.services[operator.serviceId]?.enabled !== false;
    nodes.set(id, { spec, enabled: node.enabled !== false && serviceEnabled, portIds: node.portIds! });
    const fields = spec.stateFields ?? [];
    for (const name of Object.keys(node.stateValues!)) {
      const field = fields.find((f) => f.name === name);
      if (!field || field.access === 'ro' || field.persistent !== true || field.publishable !== true || field.redactOnPublish === true)
        throw new CloudError(422, 'private_instance_value', `Nonpublishable instance state: ${id}.${name}`);
      if (!stateAjv.validate(stateSchema(field.valueSchema),node.stateValues![name]))
        throw new CloudError(422,'invalid_state_value',`Invalid configuration ${id}.${name}: ${stateAjv.errorsText()}`);
    }
  }
  const order = content.presentation!.nodeOrder!;
  if (order.length !== nodes.size || new Set(order).size !== order.length || order.some((id)=>!nodes.has(id)))
    throw new CloudError(422,'invalid_node_order','Presentation must include each template node exactly once');
  const edgeIds = new Set<string>();
  for (const edge of content.connections!) {
    const from = nodes.get(edge.fromNodeId); const to = nodes.get(edge.toNodeId);
    if (!from || !to) throw new CloudError(422, 'invalid_edge', `Missing endpoint for ${edge.edgeId}`);
    if (edgeIds.has(edge.edgeId)) throw new CloudError(422,'duplicate_edge',`Duplicate connection identity: ${edge.edgeId}`);
    edgeIds.add(edge.edgeId);
    if (edge.kind !== 'state' || !from.enabled || !to.enabled) continue;
    for (const field of to.spec.stateFields ?? []) {
      const portId = to.portIds[`state:input:${field.name}`] ?? `state:input:${field.name}`;
      const node = content.services[edge.toNodeId] ?? content.operators[edge.toNodeId];
      if (portId === edge.toPortId && Object.hasOwn(node!.stateValues!, field.name))
        throw new CloudError(422, 'upstream_instance_value', `Upstream-bound instance state: ${edge.toNodeId}.${field.name}`);
    }
  }
  if (candidate.kind === 'graph' && Object.keys(candidate.content.resources!).length)
    throw new CloudError(422, 'unsupported_resources', 'Resources are not supported by this publication contract');
  if (await publicationHash(candidate) !== candidate.contentHash)
    throw new CloudError(422, 'hash_mismatch', 'Publication content hash mismatch');
  return candidate;
}
