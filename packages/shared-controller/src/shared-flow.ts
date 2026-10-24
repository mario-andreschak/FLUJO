import { z } from 'zod';

// Browser-safe authored configuration. Runtime snapshots, credentials, schedule
// identities, private resource IDs and provider configuration are not documents.
export const SHARED_FLOW_FORMAT = 'flujo.flow.v1';
export const sharedFlowNodeTypes = ['start', 'process', 'finish', 'mcp', 'subflow', 'resource', 'signal', 'trigger', 'static'] as const;
export type SharedFlowNodeType = typeof sharedFlowNodeTypes[number];
const id = z.string().min(1).max(256);
const text = z.string().max(200_000);
const propertyNames = {
  start: ['promptTemplate'], finish: [],
  process: ['boundModel', 'promptTemplate', 'systemPromptPolicy', 'excludeModelPrompt', 'excludeStartNodePrompt',
    'excludeSystemPrompt', 'inputMode', 'isolatedPrompt', 'allowCallerPrompt', 'outputMode', 'enableTodoTool',
    'captureVariable', 'captureResource', 'captureKv', 'maxTurns', 'maxTokens', 'temperature', 'reasoningEffort',
    'thinkingLevel', 'thinkingBudget', 'contextWindow', 'compactionThreshold', 'compactionThresholdPercent',
    'allowedTools', 'terminalRouting'],
  mcp: ['boundServer', 'enabledTools', 'toolTimeout', 'includeImages'],
  subflow: ['subflowId', 'parallelSubflowIds', 'promptTemplate', 'inputMode', 'isolatedPrompt', 'outputMode',
    'allowCallerPrompt', 'allowCallerFanout', 'captureVariable', 'captureResource', 'captureKv', 'mapOverList',
    'itemSplit', 'sequential', 'concurrencyLimit', 'joinSeparator', 'errorStrategy', 'sessionScope', 'sessionKey',
    'sessionInputMode', 'sessionTurnCap', 'resultPresentation'],
  resource: ['scope', 'runName', 'boundServer', 'uri'], signal: ['topic', 'payloadTemplate'],
  // Scheduling belongs to a separately authorized Execution, not a graph copy.
  trigger: [], static: ['entries', 'injectOnce', 'outputTemplate'],
} satisfies Record<SharedFlowNodeType, string[]>;
export const sharedFlowProperties = (type: SharedFlowNodeType): readonly string[] => propertyNames[type];
const forbidden = /^(?:__proto__|prototype|constructor|apikey|api_key|accesstoken|refreshtoken|password|credential|credentials|ownercredentialbinding|authorization|cookie|env|headers|rootpath|executiondependencies|mcpnodes|resourcenodes|plannedexecutionid|personaownership|sourcemedia|localpath)$/i;

function authoredJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }]; let entries = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++entries > 20_000 || next.depth > 32) return false;
    if (typeof next.value === 'string') {
      if (next.value.length > 200_000 || /\$\{global:/i.test(next.value)) return false;
    } else if (typeof next.value === 'number') { if (!Number.isFinite(next.value)) return false; }
    else if (next.value !== null && typeof next.value === 'object') {
      for (const [key, item] of Object.entries(next.value)) {
        if (forbidden.test(key)) return false;
        pending.push({ value: item, depth: next.depth + 1 });
      }
    } else if (typeof next.value !== 'boolean' && next.value !== null) return false;
  }
  return true;
}
const properties = z.record(z.string(), z.unknown()).refine(authoredJson, 'Remove private bindings, credentials and runtime payloads before sharing.');
const node = z.object({ id, type: z.enum(sharedFlowNodeTypes), position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  data: z.object({ label: z.string().max(500), type: z.enum(sharedFlowNodeTypes), description: z.string().max(10_000).optional(), properties }).strict(),
}).strict().superRefine((value, context) => {
  if (value.type !== value.data.type || Object.keys(value.data.properties).some(key => !sharedFlowProperties(value.type).includes(key))) {
    context.addIssue({ code: 'custom', message: 'This node contains private or unsupported configuration fields.' });
  }
});
const edge = z.object({ id: z.string().min(1).max(512), source: id, target: id,
  sourceHandle: id.nullable().optional(), targetHandle: id.nullable().optional(),
  type: z.enum(['custom', 'mcpEdge', 'resourceEdge']).optional(), label: z.string().max(500).optional(),
  data: z.object({ edgeType: z.enum(['standard', 'mcp', 'resource']).optional(), bidirectional: z.boolean().optional(),
    condition: properties.optional() }).strict().optional(),
}).strict();
export const sharedFlowDocumentSchema = z.object({ format: z.literal(SHARED_FLOW_FORMAT), flow: z.object({
  name: z.string().trim().min(1).max(120), description: z.string().max(100_000).optional(),
  nodes: z.array(node).max(1000), edges: z.array(edge).max(5000),
}).strict() }).strict().superRefine((value, context) => {
  const nodes = new Set(value.flow.nodes.map(item => item.id));
  if (nodes.size !== value.flow.nodes.length || new Set(value.flow.edges.map(item => item.id)).size !== value.flow.edges.length
    || value.flow.edges.some(item => !nodes.has(item.source) || !nodes.has(item.target))) {
    context.addIssue({ code: 'custom', message: 'Use unique graph IDs and existing connection endpoints.' });
  }
});
export type SharedFlowDocument = z.infer<typeof sharedFlowDocumentSchema>;
export const sharedFlowDraftSchema = z.object({ format: z.literal('flujo.flow.draft.v1'), document: sharedFlowDocumentSchema,
  pendingFields: z.record(z.string().max(600), z.string().max(200_000)),
}).strict().superRefine((draft, context) => {
  const keys = new Set(draft.document.flow.nodes.flatMap(node => Object.keys(node.data.properties).map(key => `${node.id}:${key}`)));
  for (const edge of draft.document.flow.edges) keys.add(`edge:${edge.id}`);
  if (Object.keys(draft.pendingFields).some(key => !keys.has(key))) context.addIssue({ code: 'custom', message: 'Draft fields must belong to existing steps or connections.' });
});
export interface FlowDependency { nodeId: string; property: string; index?: number; kind: 'model' | 'mcp' | 'flow'; value: string; }
export const teamDependencyId = (kind: FlowDependency['kind'], teamId: string, resourceId: string) => `team-${kind}:${teamId}:${resourceId}`;
export function flowDependencies(document: SharedFlowDocument): FlowDependency[] {
  const result: FlowDependency[] = [];
  for (const node of document.flow.nodes) {
    const properties = node.data.properties;
    for (const [property, kind] of [['boundModel', 'model'], ['boundServer', 'mcp'], ['subflowId', 'flow']] as const) {
      if (properties[property] !== undefined) {
        if (typeof properties[property] !== 'string') throw new Error('A Flow dependency must be a shared resource reference.');
        result.push({ nodeId: node.id, property, kind, value: properties[property] });
      }
    }
    if (properties.parallelSubflowIds !== undefined) {
      if (!Array.isArray(properties.parallelSubflowIds) || properties.parallelSubflowIds.some(item => typeof item !== 'string')) throw new Error('Invalid parallel Flow dependencies.');
      properties.parallelSubflowIds.forEach((value: string, index: number) => result.push({ nodeId: node.id, property: 'parallelSubflowIds', kind: 'flow', index, value }));
    }
  }
  return result;
}
export function setFlowDependency(document: SharedFlowDocument, slot: FlowDependency, value: string): SharedFlowDocument {
  const result = structuredClone(document); const properties = result.flow.nodes.find(node => node.id === slot.nodeId)?.data.properties;
  if (!properties) throw new Error('Flow step no longer exists.');
  if (slot.index === undefined) properties[slot.property] = value;
  else (properties[slot.property] as string[])[slot.index] = value;
  return result;
}
export function readSharedFlow(value: unknown, teamId: string): SharedFlowDocument {
  const document = sharedFlowDocumentSchema.parse(value);
  for (const dependency of flowDependencies(document)) {
    if (!new RegExp(`^team-${dependency.kind}:([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})$`).test(dependency.value)
      || dependency.value.split(':')[1] !== teamId) throw new Error('Choose a shared dependency from this team for every binding.');
  }
  return document;
}

/** Explicit review projection; omitted field names are shown before publication.
 * Private dependency identities remain in the review metadata, never the draft. */
export function projectSharedFlow(input: { name: string; description?: string; nodes: unknown[]; edges: unknown[] }): {
  document: SharedFlowDocument; omitted: string[]; bindings: FlowDependency[];
} {
  const privateFlow = input as Record<string, unknown>;
  if (['executionDependencies', 'personaOwnership', 'behaviorRules', 'permissionRules'].some(key => privateFlow[key] !== undefined)) {
    throw new Error('This Flow carries private execution or Persona authority. Publish an ordinary Flow with explicit team dependencies instead.');
  }
  const omitted: string[] = [];
  const nodes = input.nodes.map((raw, index) => {
    const source = raw as z.infer<typeof node>; const type = z.enum(sharedFlowNodeTypes).parse(source.type ?? source.data.type);
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source.data.properties ?? {})) {
      if (sharedFlowProperties(type).includes(key) && authoredJson(value)) properties[key] = structuredClone(value);
      else omitted.push(`Step ${index + 1}: ${key}`);
    }
    return { id: source.id, type, position: { x: source.position.x, y: source.position.y },
      data: { label: source.data.label, type, ...(source.data.description ? { description: source.data.description } : {}), properties } };
  });
  const edges = input.edges.map(raw => {
    const source = raw as z.infer<typeof edge>;
    return { id: source.id, source: source.source, target: source.target,
      ...(source.sourceHandle ? { sourceHandle: source.sourceHandle } : {}), ...(source.targetHandle ? { targetHandle: source.targetHandle } : {}),
      ...(source.type ? { type: source.type } : {}), ...(typeof source.label === 'string' ? { label: source.label } : {}),
      ...(source.data ? { data: { ...(source.data.edgeType ? { edgeType: source.data.edgeType } : {}),
        ...(source.data.bidirectional !== undefined ? { bidirectional: source.data.bidirectional } : {}),
        ...(source.data.condition ? { condition: source.data.condition } : {}) } } : {}) };
  });
  let document = sharedFlowDocumentSchema.parse({ format: SHARED_FLOW_FORMAT,
    flow: { name: input.name, ...(input.description ? { description: input.description } : {}), nodes, edges } });
  const bindings = flowDependencies(document);
  for (const binding of bindings) document = setFlowDependency(document, binding, '');
  return { document, omitted, bindings };
}
