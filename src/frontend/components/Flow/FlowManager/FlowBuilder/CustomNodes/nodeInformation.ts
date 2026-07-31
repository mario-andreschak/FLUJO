import type { NodeType } from '@/frontend/types/flow/flow';

const DESCRIPTION_LIMIT = 180;
const PROMPT_LINE_LIMIT = 90;
const PROMPT_LINES = 3;
const SUMMARY_TOOL_LIMIT = 3;
const TECHNICAL_STRING_LIMIT = 500;
const TECHNICAL_ARRAY_LIMIT = 12;
const TECHNICAL_OBJECT_LIMIT = 20;
const TECHNICAL_DEPTH_LIMIT = 3;

const SENSITIVE_KEY = /credential|token|authorization|secret|password|api[-_ ]?key|environment|(^|[_-])env($|[_-])/i;

export interface NodeDataLike {
  label?: unknown;
  type?: unknown;
  description?: unknown;
  properties?: unknown;
}

export interface NodeSummaryEntry {
  key: string;
  label: string;
  value: string;
  multiline?: boolean;
}

export type TechnicalDetailState = 'configured' | 'empty' | 'absent' | 'default';

export interface NodeTechnicalDetail {
  key: string;
  label: string;
  state: TechnicalDetailState;
  value: string;
}

export interface NodeInformationViewModel {
  label: string;
  summary: NodeSummaryEntry[];
  technicalDetails: NodeTechnicalDetail[];
  technicalText: string;
}

interface PropertySpec {
  key: string;
  label: string;
  defaultValue?: unknown;
}

const PROPERTY_SPECS: Record<NodeType, readonly PropertySpec[]> = {
  start: [
    { key: 'promptTemplate', label: 'Prompt template' },
  ],
  process: [
    { key: 'promptTemplate', label: 'Prompt template' },
    { key: 'boundModel', label: 'Bound model' },
    { key: 'modelName', label: 'Model name' },
    { key: 'inputMode', label: 'Input mode', defaultValue: 'full-history' },
    { key: 'isolatedPrompt', label: 'Isolated prompt', defaultValue: false },
    { key: 'allowCallerPrompt', label: 'Allow caller prompt', defaultValue: true },
    { key: 'outputMode', label: 'Output mode', defaultValue: 'full-conversation' },
    { key: 'excludeModelPrompt', label: 'Exclude model prompt', defaultValue: false },
    { key: 'excludeStartNodePrompt', label: 'Exclude start prompt', defaultValue: false },
    { key: 'excludeSystemPrompt', label: 'Exclude system prompt', defaultValue: false },
    { key: 'enableTodoTool', label: 'Enable todo tool', defaultValue: false },
    { key: 'captureVariable', label: 'Capture variable' },
    { key: 'captureResource', label: 'Capture resource' },
    { key: 'captureKv', label: 'Capture key-value reference' },
    { key: 'inputSchema', label: 'Input schema' },
    { key: 'outputSchema', label: 'Output schema' },
    { key: 'handoffTools', label: 'Handoff tools' },
    { key: 'mcpNodes', label: 'Attached MCP nodes' },
  ],
  finish: [
    { key: 'successMessage', label: 'Success message' },
    { key: 'conditional', label: 'Conditional completion', defaultValue: false },
    { key: 'condition', label: 'Completion condition' },
  ],
  mcp: [
    { key: 'boundServer', label: 'Bound server' },
    { key: 'enabledTools', label: 'Enabled tools' },
    { key: 'toolTimeout', label: 'Tool timeout' },
    { key: 'roots', label: 'Roots' },
    { key: 'nameIsCustom', label: 'Custom name', defaultValue: false },
  ],
  subflow: [
    { key: 'subflowId', label: 'Bound subflow' },
    { key: 'parallelSubflowIds', label: 'Parallel subflows' },
    { key: 'parallelSubflowIdsVar', label: 'Parallel subflow variable' },
    { key: 'spawnBriefs', label: 'Spawn briefs' },
    { key: 'promptTemplate', label: 'Prompt template' },
    { key: 'inputMode', label: 'Input mode', defaultValue: 'full-history' },
    { key: 'allowCallerPrompt', label: 'Allow caller prompt', defaultValue: true },
    { key: 'allowCallerFanout', label: 'Allow caller fan-out', defaultValue: false },
    { key: 'mapOverList', label: 'Map over list', defaultValue: false },
    { key: 'itemSplit', label: 'Item split', defaultValue: 'json-array' },
    { key: 'sequential', label: 'Sequential', defaultValue: false },
    { key: 'concurrencyLimit', label: 'Concurrency limit', defaultValue: 4 },
    { key: 'errorStrategy', label: 'Error strategy', defaultValue: 'collect-all' },
    { key: 'joinSeparator', label: 'Join separator' },
    { key: 'outputMode', label: 'Output mode', defaultValue: 'steps' },
    { key: 'saveConversation', label: 'Save conversation', defaultValue: true },
  ],
  resource: [
    { key: 'scope', label: 'Scope', defaultValue: 'run' },
    { key: 'boundServer', label: 'Bound server' },
    { key: 'uri', label: 'Resource URI' },
    { key: 'runName', label: 'Run resource name' },
  ],
  signal: [
    { key: 'topic', label: 'Topic' },
    { key: 'payloadTemplate', label: 'Payload template' },
  ],
  trigger: [
    { key: 'executionId', label: 'Execution ID' },
    { key: 'name', label: 'Name' },
    { key: 'enabled', label: 'Enabled', defaultValue: true },
    { key: 'trigger', label: 'Trigger configuration' },
    { key: 'overlapStrategy', label: 'Overlap strategy', defaultValue: 'skip' },
    { key: 'prompt', label: 'Initial prompt' },
  ],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const clamp = (value: string, limit: number): string => {
  if (value.length <= limit) return value;
  const candidate = value.slice(0, Math.max(0, limit - 1));
  const boundary = candidate.lastIndexOf(' ');
  const cut = boundary > Math.floor(limit * 0.6) ? candidate.slice(0, boundary) : candidate;
  return `${cut.trimEnd()}…`;
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined => {
  const candidate = stringValue(value);
  if (candidate === undefined) return undefined;
  const normalized = normalizeWhitespace(candidate);
  return normalized || undefined;
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map(normalizeWhitespace)
        .filter(Boolean)
    : [];

const displayMode = (properties: Record<string, unknown>, key: string, fallback: string): string => {
  if (!Object.prototype.hasOwnProperty.call(properties, key)) return `${fallback} (default)`;
  const value = properties[key];
  if (typeof value === 'string') return normalizeWhitespace(value) || 'empty';
  return value === null ? 'null' : String(value);
};

const promptPreview = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  if (!value.trim()) return 'empty';
  const lines = value
    .split(/\r?\n/)
    .map(normalizeWhitespace)
    .filter(Boolean)
    .slice(0, PROMPT_LINES)
    .map((line) => clamp(line, PROMPT_LINE_LIMIT));
  return lines.length ? lines.join('\n') : 'empty';
};

const sanitizeTechnicalValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') return clamp(value, TECHNICAL_STRING_LIMIT);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined) return '[absent]';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (depth >= TECHNICAL_DEPTH_LIMIT) return '[depth limit]';

  if (Array.isArray(value)) {
    const items = value
      .slice(0, TECHNICAL_ARRAY_LIMIT)
      .map((item) => sanitizeTechnicalValue(item, depth + 1));
    if (value.length > TECHNICAL_ARRAY_LIMIT) {
      items.push(`[${value.length - TECHNICAL_ARRAY_LIMIT} more items]`);
    }
    return items;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, TECHNICAL_OBJECT_LIMIT);
  const result: Record<string, unknown> = {};
  for (const [key, nestedValue] of entries) {
    result[key] = SENSITIVE_KEY.test(key)
      ? '[redacted]'
      : sanitizeTechnicalValue(nestedValue, depth + 1);
  }
  const totalKeys = Object.keys(value as Record<string, unknown>).length;
  if (totalKeys > TECHNICAL_OBJECT_LIMIT) {
    result['…'] = `[${totalKeys - TECHNICAL_OBJECT_LIMIT} more fields]`;
  }
  return result;
};

const formatTechnicalValue = (value: unknown): string => {
  const safeValue = sanitizeTechnicalValue(value);
  if (typeof safeValue === 'string') return safeValue;
  return JSON.stringify(safeValue, null, 2);
};

const technicalDetail = (
  key: string,
  label: string,
  source: Record<string, unknown>,
  defaultValue?: unknown,
): NodeTechnicalDetail => {
  if (!Object.prototype.hasOwnProperty.call(source, key)) {
    if (defaultValue !== undefined) {
      return {
        key,
        label,
        state: 'default',
        value: `[default: ${formatTechnicalValue(defaultValue)}]`,
      };
    }
    return { key, label, state: 'absent', value: '[absent]' };
  }

  const value = source[key];
  const empty = value === '' || (Array.isArray(value) && value.length === 0);
  return {
    key,
    label,
    state: empty ? 'empty' : 'configured',
    value: empty ? (value === '' ? '[empty string]' : '[empty array]') : formatTechnicalValue(value),
  };
};

const formatTechnicalText = (details: NodeTechnicalDetail[]): string => {
  const metadata = details.filter((detail) => detail.key.startsWith('metadata.'));
  const properties = details.filter((detail) => !detail.key.startsWith('metadata.'));
  const render = (detail: NodeTechnicalDetail) => `${detail.label}: ${detail.value}`;
  return [
    'Node metadata',
    ...metadata.map(render),
    '',
    'Supported properties',
    ...properties.map(render),
  ].join('\n');
};

const addProcessSummary = (
  summary: NodeSummaryEntry[],
  properties: Record<string, unknown>,
): void => {
  summary.push({
    key: 'modes',
    label: 'Modes',
    value: `${displayMode(properties, 'inputMode', 'full-history')} → ${displayMode(properties, 'outputMode', 'full-conversation')}`,
  });
  const preview = promptPreview(properties.promptTemplate);
  if (preview !== undefined) {
    summary.push({ key: 'prompt', label: 'Prompt', value: preview, multiline: true });
  }
};

const addSubflowSummary = (
  summary: NodeSummaryEntry[],
  properties: Record<string, unknown>,
): void => {
  const subflowId = nonEmptyString(properties.subflowId);
  const parallelIds = stringArray(properties.parallelSubflowIds);
  const parallelVariable = nonEmptyString(properties.parallelSubflowIdsVar);
  const spawnBriefs = stringArray(properties.spawnBriefs);

  let target = 'Not bound';
  if (subflowId) target = subflowId;
  else if (parallelIds.length) target = `${parallelIds.length} parallel flow${parallelIds.length === 1 ? '' : 's'}`;
  else if (parallelVariable) target = `Flows from ${parallelVariable}`;
  summary.push({ key: 'target', label: 'Target', value: target });
  summary.push({
    key: 'modes',
    label: 'Modes',
    value: `${displayMode(properties, 'inputMode', 'full-history')} → ${displayMode(properties, 'outputMode', 'steps')}`,
  });

  const settings: string[] = [];
  const hasActiveFanout = !subflowId && (parallelIds.length > 0 || Boolean(parallelVariable));
  if (hasActiveFanout) settings.push(properties.sequential === true ? 'sequential fan-out' : 'parallel fan-out');
  if (properties.mapOverList === true) {
    settings.push(`map list (${displayMode(properties, 'itemSplit', 'json-array')})`);
  }
  if (spawnBriefs.length) settings.push(`${spawnBriefs.length} spawn brief${spawnBriefs.length === 1 ? '' : 's'}`);
  if (settings.length) summary.push({ key: 'execution', label: 'Execution', value: settings.join(' · ') });
};

const addMcpSummary = (
  summary: NodeSummaryEntry[],
  properties: Record<string, unknown>,
): void => {
  summary.push({
    key: 'server',
    label: 'Server',
    value: nonEmptyString(properties.boundServer) || 'Not bound',
  });
  const tools = stringArray(properties.enabledTools);
  if (tools.length) {
    const visible = tools.slice(0, SUMMARY_TOOL_LIMIT);
    const remaining = tools.length - visible.length;
    summary.push({
      key: 'tools',
      label: 'Tools',
      value: `${visible.join(', ')}${remaining > 0 ? ` +${remaining} more` : ''} (${tools.length})`,
    });
  } else {
    summary.push({ key: 'tools', label: 'Tools', value: 'None enabled' });
  }
};

const addOtherSummary = (
  summary: NodeSummaryEntry[],
  nodeType: NodeType,
  properties: Record<string, unknown>,
): void => {
  if (nodeType === 'start') {
    const preview = promptPreview(properties.promptTemplate);
    if (preview !== undefined) summary.push({ key: 'prompt', label: 'Prompt', value: preview, multiline: true });
  } else if (nodeType === 'resource') {
    const scope = displayMode(properties, 'scope', 'run');
    summary.push({ key: 'scope', label: 'Scope', value: scope });
    const resource = nonEmptyString(properties.uri) || nonEmptyString(properties.runName);
    if (resource) summary.push({ key: 'resource', label: 'Resource', value: clamp(resource, 100) });
  } else if (nodeType === 'signal') {
    const preview = promptPreview(properties.payloadTemplate);
    if (preview !== undefined) summary.push({ key: 'payload', label: 'Payload', value: preview, multiline: true });
  } else if (nodeType === 'trigger') {
    const trigger = isRecord(properties.trigger) ? properties.trigger : {};
    summary.push({
      key: 'trigger',
      label: 'Trigger',
      value: nonEmptyString(trigger.type) || 'Not configured',
    });
    summary.push({
      key: 'enabled',
      label: 'Status',
      value: properties.enabled === false ? 'Disabled' : 'Enabled',
    });
  }
};

export const buildNodeInformation = (
  data: NodeDataLike | null | undefined,
  nodeType: NodeType,
): NodeInformationViewModel => {
  const source = data || {};
  const properties = isRecord(source.properties) ? source.properties : {};
  const fallbackLabel = nodeType === 'signal' ? 'Signal' : 'No Label';
  const ordinaryLabel = nonEmptyString(source.label) || fallbackLabel;
  const label = nodeType === 'signal'
    ? nonEmptyString(properties.topic) || ordinaryLabel
    : ordinaryLabel;

  const summary: NodeSummaryEntry[] = [];
  const description = nonEmptyString(source.description);
  if (description) {
    summary.push({
      key: 'description',
      label: 'Description',
      value: clamp(description, DESCRIPTION_LIMIT),
    });
  }

  if (nodeType === 'process') addProcessSummary(summary, properties);
  else if (nodeType === 'subflow') addSubflowSummary(summary, properties);
  else if (nodeType === 'mcp') addMcpSummary(summary, properties);
  else addOtherSummary(summary, nodeType, properties);

  const metadataSource: Record<string, unknown> = {
    type: typeof source.type === 'string' && source.type ? source.type : nodeType,
    label,
  };
  if (Object.prototype.hasOwnProperty.call(source, 'description')) {
    metadataSource.description = source.description;
  }

  const technicalDetails: NodeTechnicalDetail[] = [
    technicalDetail('type', 'Type', metadataSource),
    technicalDetail('label', 'Label', metadataSource),
    technicalDetail('description', 'Description', metadataSource),
  ].map((detail) => ({ ...detail, key: `metadata.${detail.key}` }));

  for (const spec of PROPERTY_SPECS[nodeType]) {
    technicalDetails.push(technicalDetail(spec.key, spec.label, properties, spec.defaultValue));
  }

  return {
    label,
    summary,
    technicalDetails,
    technicalText: formatTechnicalText(technicalDetails),
  };
};
