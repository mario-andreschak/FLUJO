import { createHash } from 'node:crypto';

export const BUNDLED_FLUJO_WORKLOAD_PURPOSE = 'bundled-flujo-control-v1' as const;
export interface WorkloadAction { action: string; method: 'GET' | 'POST'; path: string; schemaDigest: string }
const prefix = '/api/mcp/flujo/';
export function canonicalWorkloadJson(value: unknown): string {
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error('Workload schema depth refused.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(child => walk(child, depth + 1));
    if (!item || typeof item !== 'object') throw new Error('Workload schema value refused.');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    return Object.fromEntries(Object.keys(descriptors).sort().filter(key => descriptors[key].enumerable).map(key => {
      if (!('value' in descriptors[key])) throw new Error('Workload schema accessor refused.');
      return [key, walk(descriptors[key].value, depth + 1)];
    }));
  };
  const text = JSON.stringify(walk(value, 0));
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Workload schema bytes refused.');
  return text;
}
const digest = (schema: unknown) => createHash('sha256').update(canonicalWorkloadJson(schema)).digest('hex');
const protocolSchemas: Record<string, { path: string; method: 'GET' | 'POST'; schema: Record<string, unknown> }> = {
  listTools: { path: 'tools', method: 'GET', schema: { type: 'object', additionalProperties: false } },
  listResources: { path: 'resources', method: 'GET', schema: { type: 'object', properties: { cursor: { type: 'string' } }, additionalProperties: false } },
  listResourceTemplates: { path: 'resources', method: 'GET', schema: { type: 'object', properties: { cursor: { type: 'string' } }, additionalProperties: false } },
  readResource: { path: 'resources/read', method: 'POST', schema: { type: 'object', properties: { uri: { type: 'string', minLength: 1 } }, required: ['uri'], additionalProperties: false } },
  listSkills: { path: 'skills', method: 'GET', schema: { type: 'object', properties: { cursor: { type: 'string' } }, additionalProperties: false } },
  getSkill: { path: 'skills', method: 'POST', schema: { type: 'object', properties: { uri: { type: 'string', minLength: 1 } }, required: ['uri'], additionalProperties: false } },
};

export async function computeBundledFlujoWorkloadDefinitions() {
  const [domains, tools, screenshot] = await Promise.all([import('./flujoControlApi'), import('./internalTools'), import('./systemScreenshot')]);
  const screenshotEnabled = screenshot.systemScreenshotEnabled();
  const definitions = tools.internalToolDefinitions();
  const groups = [['authoring', domains.FLUJO_AUTHORING_TOOLS], ['flows', domains.FLUJO_FLOW_TOOLS],
    ['servers', domains.FLUJO_SERVER_TOOLS], ['automation', domains.FLUJO_AUTOMATION_TOOLS], ['state', domains.FLUJO_STATE_TOOLS]] as const;
  const seen = new Set<string>();
  const result: Array<{ action: WorkloadAction; schema: Record<string, unknown>; tool: boolean }> = [];
  for (const [route, names] of groups) for (const name of names) {
    if (seen.has(name)) throw new Error('Duplicate workload action refused.');
    seen.add(name);
    const selected = definitions.filter(definition => definition.name === name);
    // Only this actual operator-gated definition may be unavailable. Changing
    // its availability changes the committed inventory and requires consent.
    if (name === 'system_screenshot' && selected.length === 0 && !screenshotEnabled
        && screenshot.systemScreenshotToolDefinition() === undefined) continue;
    if (selected.length !== 1) throw new Error('Missing or ambiguous workload definition.');
    const schema = selected[0].inputSchema;
    result.push({ action: { action: name, method: 'POST', path: prefix + route,
      schemaDigest: digest({ inputSchema: schema, annotations: selected[0].annotations ?? null }) }, schema, tool: true });
  }
  for (const [name, item] of Object.entries(protocolSchemas)) result.push({ action: {
    action: name, method: item.method, path: prefix + item.path, schemaDigest: digest(item.schema) }, schema: item.schema, tool: false });
  if (result.length > 70) throw new Error('Workload inventory exceeds its bound.');
  result.sort((left, right) => left.action.action < right.action.action ? -1 : left.action.action > right.action.action ? 1 : 0);
  canonicalWorkloadJson(result.map(item => item.action));
  if (screenshotEnabled !== screenshot.systemScreenshotEnabled()) throw new Error('Workload capability availability changed.');
  return result;
}

export async function computeBundledFlujoWorkloadInventory(): Promise<readonly WorkloadAction[]> {
  return (await computeBundledFlujoWorkloadDefinitions()).map(item => Object.freeze(item.action));
}
