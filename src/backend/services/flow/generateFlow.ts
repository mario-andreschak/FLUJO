/**
 * LLM flow generation (issue #14): "describe it, get a flow".
 *
 * Prompts a user-picked configured model to emit a compact semantic FlowSpec (NOT raw
 * ReactFlow JSON — see flowSpecCompiler.ts for why), compiles it deterministically into a
 * Flow, validates it with the shared validator, and — when validation finds errors — feeds
 * the issues back to the model for a bounded number of repair rounds.
 *
 * The result is ALWAYS an unsaved draft: the caller (the /api/flow/generate route → the
 * FlowBuilder) opens it for human review, and persisting happens only through the normal
 * save path. Errors block *running* a flow, not reviewing it, so after the repair budget is
 * exhausted the best draft is still returned along with its issues; only a hard failure
 * (no parseable spec at all, adapter error) returns an error.
 *
 * The model call copies the sampling.ts recipe exactly: getModel → resolveAndDecryptApiKey →
 * getCompletionAdapter → createCompletion. Everything stays backend-side; the response
 * carries only the flow + validation, never key material.
 */
import { createLogger } from '@/utils/logger';
import OpenAI from 'openai';
import { Flow } from '@/shared/types/flow';
import { modelService } from '@/backend/services/model';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { mcpService } from '@/backend/services/mcp';
import { flowService } from '@/backend/services/flow';
import {
  compileFlowSpec,
  CompileContext,
  CompileIssue,
  FlowSpec,
} from '@/utils/shared/flowSpecCompiler';
import {
  validateFlow,
  FlowValidationIssue,
  FlowValidationResult,
} from '@/utils/shared/flowValidation';

const log = createLogger('backend/services/flow/generateFlow');

/** Repair rounds after the initial attempt: default / hard cap. */
const DEFAULT_MAX_REPAIRS = 1;
const MAX_REPAIRS_CAP = 2;

/** Catalog bounds, to protect the generator model's context window. */
const MAX_TOOLS_PER_SERVER = 20;
const MAX_TOOL_DESCRIPTION_CHARS = 100;
const MAX_FLOWS_LISTED = 15;
const MAX_FLOW_DESCRIPTION_CHARS = 300;

export interface GenerateFlowInput {
  /** The user's natural-language description of the flow to build. */
  description: string;
  /** Id of the configured model that will do the generating. */
  modelId: string;
  /** Repair rounds after the first attempt (default 1, capped at 2). */
  maxRepairs?: number;
}

export interface GenerateFlowSuccess {
  success: true;
  /** The UNSAVED draft flow — never persisted here. */
  flow: Flow;
  /** Shared-validator result, with compile issues merged in. */
  validation: FlowValidationResult;
  /** Total model calls made (1 = first try was good enough). */
  attempts: number;
}

export interface GenerateFlowFailure {
  success: false;
  error: string;
  statusCode: number;
}

export type GenerateFlowResult = GenerateFlowSuccess | GenerateFlowFailure;

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

interface GenerationContext {
  compile: CompileContext;
  /** Human-readable catalogs folded into the system prompt. */
  catalog: string;
  /** Server status for the validator (name + status). */
  validatorServers: Array<{ name: string; status?: string }>;
}

function truncate(text: string, max: number): string {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}…`;
}

/**
 * Enumerate what the generator may wire up: configured models, MCP servers (+ tools when
 * the server is already connected — never spawn a server just to introspect it, same
 * guardrail as buildHandoffDescription), and existing flows as subflow targets.
 */
async function gatherContext(): Promise<GenerationContext> {
  const models = await modelService.loadModels();

  const lines: string[] = [];
  lines.push('AVAILABLE MODELS (reference by id or name):');
  if (models.length === 0) {
    lines.push('  (none configured)');
  }
  for (const m of models) {
    const label = m.displayName && m.displayName !== m.name ? `"${m.displayName}" (${m.name})` : m.name;
    const desc = m.description ? ` — ${truncate(m.description, MAX_TOOL_DESCRIPTION_CHARS)}` : '';
    lines.push(`  - id: ${m.id} — ${label}${desc}`);
  }

  const validatorServers: Array<{ name: string; status?: string }> = [];
  const serverTools: Record<string, string[]> = {};
  lines.push('', 'AVAILABLE MCP SERVERS (attach to process nodes via "servers"):');
  let anyServer = false;
  try {
    const configs = await mcpService.loadServerConfigs();
    if (Array.isArray(configs)) {
      for (const config of configs) {
        if (config.disabled) continue;
        anyServer = true;
        let connected = false;
        try {
          const status = await mcpService.getServerStatus(config.name);
          connected = status?.status === 'connected';
        } catch (error) {
          log.debug(`getServerStatus failed for ${config.name}; listing name only`, error);
        }
        validatorServers.push({ name: config.name, status: connected ? 'connected' : 'disconnected' });
        if (!connected) {
          lines.push(`  - ${config.name} (offline — tools unknown; may still be used)`);
          continue;
        }
        const { tools } = await mcpService.listServerTools(config.name);
        const names = (tools ?? []).map((t) => t.name).filter(Boolean);
        serverTools[config.name] = names;
        const shown = (tools ?? []).slice(0, MAX_TOOLS_PER_SERVER);
        lines.push(`  - ${config.name}:`);
        for (const tool of shown) {
          const desc = tool.description ? ` — ${truncate(tool.description, MAX_TOOL_DESCRIPTION_CHARS)}` : '';
          lines.push(`      - ${tool.name}${desc}`);
        }
        if (names.length > shown.length) {
          lines.push(`      - …and ${names.length - shown.length} more`);
        }
      }
    }
  } catch (error) {
    log.warn('Could not load MCP servers for generation context', error);
  }
  if (!anyServer) lines.push('  (none configured)');

  let flows: Flow[] = [];
  try {
    flows = await flowService.loadFlows();
  } catch (error) {
    log.warn('Could not load flows for generation context', error);
  }
  lines.push('', 'EXISTING FLOWS (usable as subflow targets via "flow"):');
  if (flows.length === 0) {
    lines.push('  (none)');
  }
  for (const flow of flows.slice(0, MAX_FLOWS_LISTED)) {
    const desc = flow.description
      ? ` — ${truncate(flow.description, MAX_FLOW_DESCRIPTION_CHARS)}`
      : ` — ${flow.nodes?.length ?? 0} nodes`;
    lines.push(`  - "${flow.name}"${desc}`);
  }
  if (flows.length > MAX_FLOWS_LISTED) {
    lines.push(`  - …and ${flows.length - MAX_FLOWS_LISTED} more`);
  }

  return {
    compile: {
      models: models.map((m) => ({ id: m.id, name: m.name, displayName: m.displayName })),
      servers: validatorServers.map((s) => ({ name: s.name })),
      serverTools,
      flows: flows.map((f) => ({ id: f.id, name: f.name })),
    },
    catalog: lines.join('\n'),
    validatorServers,
  };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(catalog: string): string {
  return `You design workflows for FLUJO, an MCP-first workflow builder. The user describes what they want; you emit a flow specification as JSON.

OUTPUT FORMAT — respond with ONLY one JSON object, no prose, no code fences:
{
  "name": "short_flow_name",            // letters/digits/_/- only
  "description": "what the flow does",
  "nodes": [ ... ],
  "edges": [ ... ]
}

NODE TYPES:
- { "key": "unique_key", "type": "start", "label": "...", "prompt": "system-level instructions for the whole flow" }
- { "key": "...", "type": "process", "label": "...", "description": "what this step does",
    "model": "<model id or name from the catalog>",
    "prompt": "instructions for this step",
    "servers": [ { "name": "<server name>", "tools": ["tool_a"] } ],   // optional; omit "tools" to enable all
    "inputMode": "full-history" | "latest-message" | "isolated",       // optional, default full-history
    "isolatedPrompt": "..." }                                           // only with inputMode "isolated"
- { "key": "...", "type": "subflow", "label": "...", "flow": "<existing flow name>",
    "inputMode": "full-history" | "latest-message" | "isolated",
    "outputMode": "steps" | "final-only" }
- { "key": "...", "type": "finish", "label": "..." }

EDGES: { "from": "<node key>", "to": "<node key>", "bidirectional": true|false }

RULES:
1. Exactly ONE start node; at least one finish node reachable from it.
2. Every process node MUST reference a model from the catalog below.
3. A process step uses MCP tools ONLY via its "servers" list — never emit nodes of type "mcp".
4. Do not embed \${tool:...} or \${resource:...} references in prompts — tools are wired through "servers".
5. Branching: give a process node multiple outgoing edges; its model decides where to hand off at runtime. "bidirectional": true lets the target hand back to the source (agent ↔ agent).
6. A subflow node may have only ONE outgoing edge, and its "flow" must name an existing flow from the catalog.
7. Keep flows minimal — only the steps the task needs. Write clear, specific prompts and labels; fill "description" on process nodes.

${catalog}`;
}

function issueLines(issues: Array<{ severity: string; message: string }>): string {
  return issues.map((i) => `- [${i.severity}] ${i.message}`).join('\n');
}

// ---------------------------------------------------------------------------
// JSON extraction — models love fences and prefaces despite instructions
// ---------------------------------------------------------------------------

/** Extract the first balanced top-level JSON object from free text (string-aware). */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Issue merging
// ---------------------------------------------------------------------------

/** Fold compile issues into the validator's result shape (single list for the caller). */
function mergeIssues(
  compileIssues: CompileIssue[],
  validation: FlowValidationResult
): FlowValidationResult {
  const compiled: FlowValidationIssue[] = compileIssues.map((i) => ({
    severity: i.severity,
    code: i.code,
    message: i.message,
  }));
  const issues = [...compiled, ...validation.issues];
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return {
    issues,
    errorCount,
    warningCount: issues.length - errorCount,
    isRunnable: errorCount === 0,
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export async function generateFlow(input: GenerateFlowInput): Promise<GenerateFlowResult> {
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  if (!description) {
    return { success: false, error: 'A flow description is required', statusCode: 400 };
  }
  if (!input?.modelId || typeof input.modelId !== 'string') {
    return { success: false, error: 'A generator model id is required', statusCode: 400 };
  }

  const model = await modelService.getModel(input.modelId);
  if (!model) {
    return { success: false, error: `Generator model not found: ${input.modelId}`, statusCode: 404 };
  }
  const apiKey = await modelService.resolveAndDecryptApiKey(model.ApiKey);
  if (!apiKey) {
    return { success: false, error: 'Could not resolve the generator model API key', statusCode: 500 };
  }

  const context = await gatherContext();
  const adapter = getCompletionAdapter(model);

  const maxRepairs = Math.min(
    typeof input.maxRepairs === 'number' && input.maxRepairs >= 0 ? input.maxRepairs : DEFAULT_MAX_REPAIRS,
    MAX_REPAIRS_CAP
  );

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(context.catalog) },
    { role: 'user', content: description },
  ];

  let best: { flow: Flow; validation: FlowValidationResult } | null = null;
  let attempts = 0;

  for (let round = 0; round <= maxRepairs; round++) {
    attempts++;
    let raw: string;
    try {
      const { completion } = await adapter.createCompletion({
        model,
        apiKey,
        messages,
        temperature: 0,
      });
      const content = completion.choices?.[0]?.message?.content;
      raw = typeof content === 'string' ? content : '';
    } catch (error) {
      log.error('Generator model call failed', error);
      // A dead adapter won't come back within this request — don't burn repair rounds.
      if (best) break;
      return {
        success: false,
        error: `The generator model call failed: ${error instanceof Error ? error.message : String(error)}`,
        statusCode: 502,
      };
    }

    const spec = extractJsonObject(raw) as FlowSpec | null;
    if (!spec) {
      log.warn(`Attempt ${attempts}: model output contained no parseable JSON object`);
      messages.push(
        { role: 'assistant', content: raw },
        { role: 'user', content: 'Your reply contained no parseable JSON object. Re-emit the COMPLETE flow specification as a single JSON object and nothing else.' }
      );
      continue;
    }

    const compiled = compileFlowSpec(spec, context.compile);
    if (!compiled.flow) {
      messages.push(
        { role: 'assistant', content: raw },
        { role: 'user', content: `The specification could not be compiled:\n${issueLines(compiled.issues)}\nFix these problems and re-emit the COMPLETE corrected JSON (only the JSON).` }
      );
      continue;
    }

    const validation = mergeIssues(
      compiled.issues,
      validateFlow(compiled.flow, {
        models: context.compile.models,
        servers: context.validatorServers,
        serverTools: context.compile.serverTools,
      })
    );
    best = { flow: compiled.flow, validation };

    if (validation.errorCount === 0) break;

    log.info(`Attempt ${attempts}: flow has ${validation.errorCount} error(s)` + (round < maxRepairs ? '; asking the model to repair' : '; repair budget exhausted'));
    if (round < maxRepairs) {
      // Feed ALL issues back, not just errors: the actionable detail often lives in a
      // warning (e.g. the compile warning names the unresolvable model; the validator
      // error only says a model is missing).
      messages.push(
        { role: 'assistant', content: raw },
        { role: 'user', content: `The flow you specified has these problems:\n${issueLines(validation.issues)}\nFix the errors (warnings are advisory) and re-emit the COMPLETE corrected JSON (only the JSON).` }
      );
    }
  }

  if (!best) {
    return {
      success: false,
      error: 'The model did not produce a usable flow specification. Try rephrasing the description or a different generator model.',
      statusCode: 422,
    };
  }

  log.info(`Generated draft flow "${best.flow.name}" in ${attempts} attempt(s): ${best.validation.errorCount} error(s), ${best.validation.warningCount} warning(s)`);
  return { success: true, flow: best.flow, validation: best.validation, attempts };
}
