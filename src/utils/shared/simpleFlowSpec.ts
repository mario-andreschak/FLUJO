/**
 * Guided flow-authoring contract (issue #338).
 *
 * SimpleFlowSpec is deliberately small enough for a compact model or a human
 * form to author reliably. It is not a second runtime format: the pure lowerer
 * expands it into the existing FlowSpec and the normal compiler remains the
 * single source of truth for ReactFlow output.
 */
import type { EdgeCondition } from './edgeConditions';
import {
  compileFlowSpec,
  type CompileContext,
  type CompileIssue,
  type CompileOptions,
  type CompileResult,
  type FlowSpec,
  type FlowSpecEdge,
  type FlowSpecNode,
  type FlowSpecServerRef,
} from './flowSpecCompiler';

export const SIMPLE_FLOW_SPEC_VERSION = 1 as const;

export interface SimpleFlowStep {
  /** Stable local identifier used by optional routes. */
  id: string;
  /** Plain-language instruction for this step. */
  task: string;
  /** Human-facing label. Defaults to a title derived from id. */
  label?: string;
  /** Optional per-step model override. Defaults to the top-level model. */
  model?: string;
  /** MCP capabilities in `server/tool` form. `server` enables all known tools. */
  tools?: string[];
  /** Existing flow id/name. When present this is a subflow step, not a model step. */
  flow?: string;
}

export interface SimpleFlowRoute {
  from: string;
  to: string;
  /** Optional deterministic condition. Omit for the fallback route. */
  when?: Pick<EdgeCondition, 'kind' | 'value' | 'ignoreCase' | 'negate'>;
}

export interface SimpleFlowSpec {
  profile?: 'simple';
  version?: typeof SIMPLE_FLOW_SPEC_VERSION;
  name: string;
  goal: string;
  /** Default model for agent steps. Individual steps may override it. */
  model?: string;
  steps: SimpleFlowStep[];
  /**
   * Omit for a linear flow in step order. When supplied, routes describe the
   * step-to-step graph; entry and terminal edges are inferred.
   */
  routes?: SimpleFlowRoute[];
}

/**
 * JSON Schema used by MCP tools and model structured-output adapters. Keeping
 * it next to the TypeScript contract prevents giant prose descriptions from
 * becoming the effective schema.
 */
export const SIMPLE_FLOW_SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'goal', 'steps'],
  properties: {
    profile: { type: 'string', const: 'simple' },
    version: { type: 'integer', const: SIMPLE_FLOW_SPEC_VERSION },
    name: { type: 'string', minLength: 1 },
    goal: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'task'],
        properties: {
          id: { type: 'string', minLength: 1, pattern: '^[A-Za-z][A-Za-z0-9_-]*$' },
          task: { type: 'string', minLength: 1 },
          label: { type: 'string', minLength: 1 },
          model: { type: 'string', minLength: 1 },
          tools: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
          },
          flow: { type: 'string', minLength: 1 },
        },
      },
    },
    routes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1 },
          when: {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: ['contains', 'equals', 'regex', 'always'] },
              value: { type: 'string' },
              ignoreCase: { type: 'boolean' },
              negate: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
} as const;

export interface LowerSimpleFlowResult {
  spec: FlowSpec;
  issues: CompileIssue[];
}

export interface CompileSimpleFlowResult extends CompileResult {
  /** Expanded advanced spec, useful for previews and repair feedback. */
  loweredSpec: FlowSpec;
}

function titleFromId(id: string): string {
  const text = id.replace(/[_-]+/g, ' ').trim();
  return text ? text.replace(/\b\w/g, (char) => char.toUpperCase()) : 'Step';
}

function serversFromTools(tools: string[] | undefined, nodeKey: string, issues: CompileIssue[]): FlowSpecServerRef[] {
  const grouped = new Map<string, Set<string>>();
  for (const raw of tools ?? []) {
    const ref = typeof raw === 'string' ? raw.trim() : '';
    if (!ref) continue;
    const slash = ref.indexOf('/');
    const server = (slash >= 0 ? ref.slice(0, slash) : ref).trim();
    const tool = slash >= 0 ? ref.slice(slash + 1).trim() : '';
    if (!server) {
      issues.push({
        severity: 'warning',
        code: 'simple-tool-invalid',
        nodeKey,
        message: `Step "${nodeKey}": ignored tool reference "${ref}"; use server/tool.`,
      });
      continue;
    }
    if (!grouped.has(server)) grouped.set(server, new Set());
    if (tool) grouped.get(server)!.add(tool);
  }
  return [...grouped].map(([name, names]) => ({
    name,
    ...(names.size > 0 ? { tools: [...names] } : {}),
  }));
}

/**
 * Deterministically expand a guided specification into the full FlowSpec.
 * Invalid references are reported and skipped; the normal compiler then
 * performs model/server/flow resolution and structural validation.
 */
export function lowerSimpleFlowSpec(simple: SimpleFlowSpec): LowerSimpleFlowResult {
  const issues: CompileIssue[] = [];
  const inputSteps = Array.isArray(simple?.steps) ? simple.steps : [];
  const seen = new Set<string>();
  const steps: SimpleFlowStep[] = [];

  for (const candidate of inputSteps) {
    const id = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
    const task = typeof candidate?.task === 'string' ? candidate.task.trim() : '';
    if (!id || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
      issues.push({
        severity: 'error',
        code: 'simple-step-id-invalid',
        message: 'Every simple step needs an id matching ^[A-Za-z][A-Za-z0-9_-]*$.',
      });
      continue;
    }
    if (seen.has(id)) {
      issues.push({
        severity: 'error',
        code: 'simple-step-id-duplicate',
        nodeKey: id,
        message: `Duplicate simple step id "${id}"; the later step was dropped.`,
      });
      continue;
    }
    if (!task) {
      issues.push({
        severity: 'error',
        code: 'simple-step-task-missing',
        nodeKey: id,
        message: `Step "${id}" needs a non-empty task.`,
      });
      continue;
    }
    seen.add(id);
    steps.push({ ...candidate, id, task });
  }

  const startKey = '__start';
  const finishKey = '__finish';
  const nodes: FlowSpecNode[] = [{
    key: startKey,
    type: 'start',
    label: 'Start',
    prompt: `Execute this workflow toward its stated goal: ${typeof simple?.goal === 'string' ? simple.goal.trim() : ''}`,
  }];

  for (const step of steps) {
    const label = typeof step.label === 'string' && step.label.trim()
      ? step.label.trim()
      : titleFromId(step.id);
    const flow = typeof step.flow === 'string' ? step.flow.trim() : '';
    if (flow) {
      nodes.push({
        key: step.id,
        type: 'subflow',
        label,
        description: step.task,
        flow,
        prompt: step.task,
        inputMode: 'full-history',
        outputMode: 'final-only',
      });
      continue;
    }
    const model = typeof step.model === 'string' && step.model.trim()
      ? step.model.trim()
      : typeof simple?.model === 'string'
        ? simple.model.trim()
        : '';
    nodes.push({
      key: step.id,
      type: 'process',
      label,
      description: step.task,
      prompt: step.task,
      ...(model ? { model } : {}),
      servers: serversFromTools(step.tools, step.id, issues),
      inputMode: 'full-history',
      outputMode: 'latest-message',
    });
  }
  nodes.push({ key: finishKey, type: 'finish', label: 'Finish' });

  const edges: FlowSpecEdge[] = [];
  const routes = Array.isArray(simple?.routes) ? simple.routes : [];
  if (routes.length === 0) {
    const chain = [startKey, ...steps.map((step) => step.id), finishKey];
    for (let index = 0; index < chain.length - 1; index++) {
      edges.push({ from: chain[index], to: chain[index + 1] });
    }
  } else {
    const incoming = new Set<string>();
    const outgoing = new Set<string>();
    for (const route of routes) {
      const from = typeof route?.from === 'string' ? route.from.trim() : '';
      const to = typeof route?.to === 'string' ? route.to.trim() : '';
      if (!seen.has(from) || !seen.has(to)) {
        issues.push({
          severity: 'error',
          code: 'simple-route-unresolved',
          nodeKey: from || undefined,
          message: `Simple route "${from}" → "${to}" references an unknown step.`,
        });
        continue;
      }
      edges.push({ from, to, ...(route.when ? { condition: route.when as EdgeCondition } : {}) });
      outgoing.add(from);
      incoming.add(to);
    }
    for (const step of steps) {
      if (!incoming.has(step.id)) edges.push({ from: startKey, to: step.id });
      if (!outgoing.has(step.id)) edges.push({ from: step.id, to: finishKey });
    }
  }

  return {
    spec: {
      name: typeof simple?.name === 'string' ? simple.name.trim() : '',
      description: typeof simple?.goal === 'string' ? simple.goal.trim() : '',
      nodes,
      edges,
    },
    issues,
  };
}

/** Lower and compile through the existing advanced compiler. */
export function compileSimpleFlowSpec(
  simple: SimpleFlowSpec,
  context: CompileContext = {},
  options: CompileOptions = {},
): CompileSimpleFlowResult {
  const lowered = lowerSimpleFlowSpec(simple);
  // A SimpleFlowSpec always describes a newly authored flow. Preserve an
  // explicit caller override, but otherwise use the current Subflow defaults.
  const compiled = compileFlowSpec(lowered.spec, context, {
    newSubflowDefaults: true,
    ...options,
  });
  const issues = [...lowered.issues, ...compiled.issues];
  return {
    ...compiled,
    loweredSpec: lowered.spec,
    issues,
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
  };
}
