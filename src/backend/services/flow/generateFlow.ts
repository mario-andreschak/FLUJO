/**
 * LLM flow generation (issue #14): "describe it, get a flow".
 *
 * Prompts a user-picked configured model to emit a compact semantic FlowSpec (NOT raw
 * ReactFlow JSON — see flowSpecCompiler.ts for why), compiles it deterministically into a
 * Flow, validates it with the shared validator, and — when validation finds errors — feeds
 * the issues back to the model for a bounded number of repair rounds.
 *
 * CAPABILITY ACQUISITION (brain / self-improvement track): the generator is agentic. It
 * can always SEARCH the public MCP registry (read-only, safe) so it knows what the flow
 * *could* use; with the per-generation `allowInstall` opt-in it can also INSTALL servers —
 * download + run third-party packages — and wire the new tools into the flow. That is the
 * "add skills" story: "sing me a song" should find a TTS/synth server, not settle for a
 * poem. Installs are reported back to the caller.
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
 *
 * The FlowSpec DSL text and the building-block catalog are shared with the non-LLM
 * authoring surfaces (POST /api/flow/compile, the MCP authoring tools) via
 * `flowSpecDoc.ts` and `generationContext.ts`, so the formats can never drift.
 */
import { createLogger } from '@/utils/logger';
import OpenAI from 'openai';
import { Flow } from '@/shared/types/flow';
import { modelService } from '@/backend/services/model';
import { getCompletionAdapter, CompletionAdapter } from '@/backend/services/model/adapters';
import { Model, normalizeMaxTokens } from '@/shared/types/model';
import {
  compileFlowSpec,
  applyGenerationDefaults,
  flowToSpec,
  FlowSpec,
  FlowSpecNode,
  MAX_SUBFLOW_DEPTH,
  MAX_GENERATED_FLOWS,
} from '@/utils/shared/flowSpecCompiler';
import { validateFlow, FlowValidationResult } from '@/utils/shared/flowValidation';
import { repairFlowSpec, RepairChange } from '@/utils/shared/flowAutoRepair';
import { FLOWSPEC_DOC } from '@/utils/shared/flowSpecDoc';
import { searchRegistry, installRegistryServer } from '@/backend/services/mcp/registryInstall';
import { loadAutoInstallSettings, appendInstallAudit } from '@/backend/services/mcp/autoInstall';
import { decideInstallConsent, planToAuditEntry } from '@/utils/mcp/autoInstallConsent';
import { gatherGenerationContext, mergeIssues, GenerationContext } from './generationContext';

const log = createLogger('backend/services/flow/generateFlow');

/** Repair rounds after the initial attempt: default / hard cap. */
const DEFAULT_MAX_REPAIRS = 1;
const MAX_REPAIRS_CAP = 2;
/** Search/install tool-calling turns allowed within one attempt. */
const MAX_TOOL_TURNS = 8;
/** Default nesting depth for multi-level generation (issue #94); hard cap is MAX_SUBFLOW_DEPTH. */
const DEFAULT_MAX_DEPTH = 2;

function clampDepth(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULT_MAX_DEPTH;
  return Math.max(0, Math.min(MAX_SUBFLOW_DEPTH, Math.floor(value)));
}

export interface GenerateFlowInput {
  /** The user's natural-language description of the flow to build. */
  description: string;
  /** Id of the configured model that will do the generating. */
  modelId: string;
  /** Repair rounds after the first attempt (default 1, capped at 2). */
  maxRepairs?: number;
  /**
   * Let the generator INSTALL MCP servers from the public registry when the flow
   * needs capabilities no configured server provides. Installing means downloading
   * and RUNNING third-party packages on this machine — strictly opt-in per
   * generation (the UI carries the warning). Searching is always allowed.
   */
  allowInstall?: boolean;
  /**
   * Let the generator author MULTI-LEVEL flows (issue #94): a subflow node may carry an
   * inline child spec (`subflowSpec`) or a recursive generation instruction
   * (`generateSubflow`), producing a whole BUNDLE of draft flows. Off by default; when
   * off, subflows may only reference existing flows.
   */
  allowSubflows?: boolean;
  /** Max subflow nesting depth (default 2, hard cap MAX_SUBFLOW_DEPTH). Only used with allowSubflows. */
  maxDepth?: number;
}

/** One compiled draft flow in a generated bundle, with its own validation. */
export interface GeneratedFlowEntry {
  flow: Flow;
  validation: FlowValidationResult;
}

/**
 * A server the generator installed (or found already present) during a run.
 * Carries the resolved command/args + verification status (SEP-1024) so the
 * post-generation summary can show EXACTLY what was run per install.
 */
export interface InstalledServerInfo {
  name: string;
  tools: string[];
  alreadyExisted?: boolean;
  /** The exact runner command that was spawned (stdio packages). */
  command?: string;
  /** Untruncated argument vector that was spawned. */
  args?: string[];
  /** Registry verification status; 'unverified' when the registry asserted none. */
  verificationStatus?: string;
}

export interface GenerateFlowSuccess {
  success: true;
  /** The UNSAVED root draft flow — never persisted here (back-compat with single-flow callers). */
  flow: Flow;
  /**
   * Shared-validator result covering the WHOLE bundle, with compile issues merged in
   * (single-flow drafts: identical to validating just `flow`).
   */
  validation: FlowValidationResult;
  /**
   * The full bundle of UNSAVED draft flows (root + inline/generated subflow descendants),
   * in dependency order (descendants before the root) so the caller persists them
   * descendants-first. For a non-nested draft this is a single entry.
   */
  flows: GeneratedFlowEntry[];
  /** Id of the root flow within `flows` (the one the reviewer opens in the builder). */
  rootFlowId: string;
  /** Total spec-producing attempts (1 = first try was good enough). */
  attempts: number;
  /** Servers the generator installed (or found already present) along the way. */
  installedServers: InstalledServerInfo[];
}

export interface GenerateFlowFailure {
  success: false;
  error: string;
  statusCode: number;
}

export type GenerateFlowResult = GenerateFlowSuccess | GenerateFlowFailure;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  catalog: string,
  allowInstall: boolean,
  allowSubflows: boolean,
  maxDepth: number
): string {
  const nesting = allowSubflows
    ? `MULTI-LEVEL FLOWS — you MAY design subflows that are themselves brand-new flows:
- A subflow node normally references an EXISTING flow via "flow". To instead create a NEW child flow, use ONE of these on the subflow node (not "flow"):
  - "subflowSpec": an inline nested FlowSpec (you author the whole child now), or
  - "generateSubflow": a short natural-language description of the child — FLUJO will generate that child flow for you.
- Nest only when a self-contained sub-task genuinely deserves its own flow. Nesting is bounded: at most ${maxDepth} level(s) deep and ${MAX_GENERATED_FLOWS} flows total. Keep it minimal.`
    : `SUBFLOWS: a subflow node's "flow" must reference an EXISTING flow (by name or id). Do NOT use "subflowSpec" or "generateSubflow" — multi-level generation is off for this run.`;

  const acquisition = allowInstall
    ? `CAPABILITY ACQUISITION — you are allowed to EXPAND this FLUJO instance:
- If the task needs a capability none of the configured servers provides (voice, vision, browsing, email, code execution, …), use search_mcp_marketplace to find a server for it, then install_mcp_server to install the best match. Prefer servers that need no API keys (empty requiredEnv); if the best option needs keys, install a keyless alternative or note the requirement in the flow description.
- After a successful install, reference the returned server name in a process node's "servers" list and enable the tools it reported.
- Be ambitious: an actual capability (real audio, real browsing, real files) beats a text approximation. Search with several short terms ("voice", "tts", "speech") — the registry matches server NAMES only.`
    : `CAPABILITY DISCOVERY — you may search but NOT install:
- If the task needs a capability none of the configured servers provides, you may use search_mcp_marketplace to see what exists. Do NOT reference unconfigured servers in the spec; instead mention the recommended server (its registry name) in the flow "description" so the user can install it.`;

  return `You design workflows for FLUJO, an MCP-first workflow builder. The user describes what they want; you emit a flow specification as JSON.

OUTPUT FORMAT — when you are done (after any tool use), respond with ONLY one JSON object, no prose, no code fences.

${FLOWSPEC_DOC}

GENERATED-FLOW DEFAULTS (context saving): process nodes you leave without an explicit inputMode/outputMode are compiled with inputMode "latest-message" and outputMode "latest-message" — each step sees only the current task and later steps see only its final response, not its tool calls/results. When a step genuinely needs the whole conversation or later steps need its intermediate work, set "full-history" / "full-conversation" explicitly.

${acquisition}

${nesting}

${catalog}`;
}

function issueLines(issues: Array<{ severity: string; message: string }>): string {
  return issues.map((i) => `- [${i.severity}] ${i.message}`).join('\n');
}

// ---------------------------------------------------------------------------
// Generator tools (marketplace search / install)
// ---------------------------------------------------------------------------

function generatorTools(allowInstall: boolean): OpenAI.ChatCompletionTool[] {
  const tools: OpenAI.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'search_mcp_marketplace',
        description:
          'Search the public MCP server registry. The registry matches the query against server NAMES only (substring), so use short single terms ("voice", "tts", "browser") and try several. Returns name, description, whether FLUJO can install it, and which env vars/keys it requires.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Short search term matched against server names.' },
          },
          required: ['query'],
        },
      },
    },
  ];
  if (allowInstall) {
    tools.push({
      type: 'function',
      function: {
        name: 'install_mcp_server',
        description:
          'Install an MCP server from the registry (by the exact name returned by search) and connect it. Returns the server name to reference in the spec and the tools it provides — or needsEnv when required keys are missing (then pick an alternative or note it for the user). Installing can take a while (package download).',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Exact registry name from search results, e.g. "ai.keenable/web-search".' },
          },
          required: ['name'],
        },
      },
    });
  }
  return tools;
}

interface ToolLoopState {
  installedServers: InstalledServerInfo[];
  /** True once an install happened → the building-block context must be re-gathered. */
  contextDirty: boolean;
}

async function executeGeneratorTool(
  name: string,
  args: Record<string, unknown>,
  allowInstall: boolean,
  state: ToolLoopState
): Promise<unknown> {
  if (name === 'search_mcp_marketplace') {
    const query = typeof args.query === 'string' ? args.query : '';
    try {
      return await searchRegistry(query);
    } catch (err) {
      return { error: `Registry search failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (name === 'install_mcp_server') {
    if (!allowInstall) {
      return { error: 'Installing is not allowed in this generation (allowInstall is off).' };
    }
    const serverRef = typeof args.name === 'string' ? args.name : '';

    // SEP-1024: resolve WITHOUT spawning first so the exact command/args are
    // captured for the audit log before anything runs. The per-generation
    // allowInstall opt-in IS the consent for the generator (brain-stem policy).
    const resolved = await installRegistryServer(serverRef, undefined, { resolveOnly: true });
    const settings = await loadAutoInstallSettings();
    const decision = decideInstallConsent({
      caller: 'generator',
      settings,
      registryName: serverRef,
      allowInstall,
    });
    if (resolved.plan) {
      await appendInstallAudit(planToAuditEntry(resolved.plan, 'generator', decision, false));
    }

    const result = await installRegistryServer(serverRef);
    if (result.plan) {
      await appendInstallAudit(
        planToAuditEntry(result.plan, 'generator', decision, result.installed, result.error)
      );
    }
    if (result.installed && result.serverName) {
      state.contextDirty = true;
      state.installedServers.push({
        name: result.serverName,
        tools: (result.tools ?? []).map((t) => t.name),
        ...(result.alreadyExisted ? { alreadyExisted: true } : {}),
        ...(result.plan?.command ? { command: result.plan.command } : {}),
        ...(result.plan?.args ? { args: result.plan.args } : {}),
        ...(result.plan?.verificationStatus ? { verificationStatus: result.plan.verificationStatus } : {}),
      });
    }
    return result;
  }
  return { error: `Unknown tool: ${name}` };
}

/**
 * One model "turn" that may use search/install tools before producing text.
 * Bounded by MAX_TOOL_TURNS; on budget exhaustion the tools are withdrawn and
 * the model is asked to emit the spec with what it has.
 */
async function runModelTurn(
  adapter: CompletionAdapter,
  model: Model,
  apiKey: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[],
  allowInstall: boolean,
  state: ToolLoopState
): Promise<string> {
  // Executors for the self-orchestrating adapters (Claude subscription): their
  // tool calls never surface as tool_calls to this loop, so the adapter must run
  // the tools itself via CompletionInput.localToolExecutors. Request/response
  // adapters ignore this and we handle tool_calls below.
  const localToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  for (const t of tools) {
    if (t.type !== 'function') continue;
    const name = t.function.name;
    localToolExecutors[name] = (args) => executeGeneratorTool(name, args, allowInstall, state);
  }

  for (let turn = 0; turn <= MAX_TOOL_TURNS; turn++) {
    const withTools = tools.length > 0 && turn < MAX_TOOL_TURNS;
    const { completion } = await adapter.createCompletion({
      model,
      apiKey,
      messages,
      temperature: 0,
      maxTokens: normalizeMaxTokens(model.maxTokens),
      ...(withTools ? { tools, localToolExecutors } : {}),
    });
    const message = completion.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];

    if (toolCalls.length === 0) {
      return typeof message?.content === 'string' ? message.content : '';
    }

    // Record the assistant turn, execute each call, append the results, loop.
    messages.push({
      role: 'assistant',
      content: message?.content ?? null,
      tool_calls: toolCalls,
    } as OpenAI.ChatCompletionMessageParam);

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* malformed arguments → run with empty args; the tool reports its own error */
      }
      log.info(`Generator tool call: ${call.function.name}(${call.function.arguments})`);
      const result = await executeGeneratorTool(call.function.name, args, allowInstall, state);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }

    if (turn === MAX_TOOL_TURNS - 1) {
      messages.push({
        role: 'user',
        content: 'Tool budget exhausted. Emit the COMPLETE flow specification now as a single JSON object using what you have.',
      });
    }
  }
  return '';
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
  const allowInstall = input.allowInstall === true;
  const allowSubflows = input.allowSubflows === true;
  // No nesting allowed when the option is off (0 caps any stray subflowSpec the model emits).
  const maxDepth = allowSubflows ? clampDepth(input.maxDepth) : 0;

  const model = await modelService.getModel(input.modelId);
  if (!model) {
    return { success: false, error: `Generator model not found: ${input.modelId}`, statusCode: 404 };
  }
  const apiKey = await modelService.resolveAndDecryptApiKey(model.ApiKey);
  if (!apiKey) {
    return { success: false, error: 'Could not resolve the generator model API key', statusCode: 500 };
  }

  let context: GenerationContext = await gatherGenerationContext();
  const adapter = getCompletionAdapter(model);
  const tools = generatorTools(allowInstall);
  const state: ToolLoopState = { installedServers: [], contextDirty: false };

  const maxRepairs = Math.min(
    typeof input.maxRepairs === 'number' && input.maxRepairs >= 0 ? input.maxRepairs : DEFAULT_MAX_REPAIRS,
    MAX_REPAIRS_CAP
  );

  // Total flows authored this attempt (root + generated descendants) — bounds the recursive
  // LLM calls independently of the compiler's own cap. Reset per attempt.
  let generatedFlowCount = 1;

  /**
   * Generate a child FlowSpec from a natural-language description on its OWN message thread
   * (so it never pollutes the root conversation). Shares the tool loop + install state, so
   * capability acquisition during a child generation is reported globally.
   */
  async function generateChildSpec(childDescription: string, depth: number): Promise<FlowSpec | null> {
    const childMessages: OpenAI.ChatCompletionMessageParam[] = [
      // A child may nest further only if its own children would stay within maxDepth.
      { role: 'system', content: buildSystemPrompt(context.catalog, allowInstall, allowSubflows && depth < maxDepth, maxDepth) },
      { role: 'user', content: childDescription },
    ];
    let raw: string;
    try {
      // model/apiKey are non-null here (guarded above); the assertions satisfy the closure.
      raw = await runModelTurn(adapter, model!, apiKey!, childMessages, tools, allowInstall, state);
    } catch (err) {
      log.warn('A child subflow generation call failed; leaving the subflow unresolved', err);
      return null;
    }
    const childSpec = extractJsonObject(raw) as FlowSpec | null;
    return childSpec && typeof childSpec === 'object' ? childSpec : null;
  }

  /**
   * Walk a spec's subflow nodes and turn every `generateSubflow` instruction into an inline
   * `subflowSpec` (recursively), so the deterministic compiler can wire the whole bundle.
   * Bounded by depth and the total-flow budget; also descends into author-supplied inline
   * subflowSpecs to expand any `generateSubflow` nested within them.
   */
  async function expandSubflowSpecs(levelSpec: FlowSpec, depth: number): Promise<void> {
    if (!levelSpec || !Array.isArray(levelSpec.nodes)) return;
    for (const node of levelSpec.nodes as FlowSpecNode[]) {
      if (node?.type !== 'subflow') continue;
      // Precedence flow > subflowSpec > generateSubflow: an existing-flow reference or an
      // author-supplied inline spec wins; only descend into the latter to expand its own
      // generateSubflow nodes.
      if (node.flow) continue;
      if (node.subflowSpec) {
        await expandSubflowSpecs(node.subflowSpec, depth + 1);
        continue;
      }
      const childDescription = typeof node.generateSubflow === 'string' ? node.generateSubflow.trim() : '';
      if (!childDescription) continue;
      // Out of budget/depth: drop the instruction. The compiler then reports the subflow as
      // targetless (a visible, repairable error) rather than silently doing nothing.
      if (depth + 1 > maxDepth || generatedFlowCount >= MAX_GENERATED_FLOWS) {
        log.info(`Not expanding generateSubflow (depth ${depth + 1}, ${generatedFlowCount} flows so far): budget/depth reached`);
        continue;
      }
      const childSpec = await generateChildSpec(childDescription, depth + 1);
      if (childSpec) {
        generatedFlowCount++;
        node.subflowSpec = childSpec;
        delete node.generateSubflow;
        await expandSubflowSpecs(childSpec, depth + 1);
      } else {
        delete node.generateSubflow;
      }
    }
  }

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(context.catalog, allowInstall, allowSubflows, maxDepth) },
    { role: 'user', content: description },
  ];

  let best: { flows: GeneratedFlowEntry[]; rootFlow: Flow; validation: FlowValidationResult } | null = null;
  let attempts = 0;

  for (let round = 0; round <= maxRepairs; round++) {
    attempts++;
    generatedFlowCount = 1;
    let raw: string;
    try {
      raw = await runModelTurn(adapter, model, apiKey, messages, tools, allowInstall, state);
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
      // A mid-turn install still counts: refresh the context so the next attempt sees it.
      if (state.contextDirty) {
        try {
          context = await gatherGenerationContext();
        } catch (err) {
          log.warn('Re-gathering context after install failed; keeping the stale catalog', err);
        }
        state.contextDirty = false;
      }
      messages.push(
        { role: 'assistant', content: raw },
        { role: 'user', content: 'Your reply contained no parseable JSON object. Re-emit the COMPLETE flow specification as a single JSON object and nothing else.' }
      );
      continue;
    }

    // Multi-level: turn generateSubflow instructions into inline child specs (recursive LLM
    // calls) BEFORE compiling. No-op when the spec has none / the option is off.
    if (allowSubflows) {
      try {
        await expandSubflowSpecs(spec, 0);
      } catch (err) {
        log.warn('Subflow expansion failed; compiling the root spec as-is', err);
      }
    }

    // An install (root or child generation) changed what exists — re-gather so
    // compile/validate see the new server + tools (and unknown-server warnings don't fire
    // on fresh installs).
    if (state.contextDirty) {
      try {
        context = await gatherGenerationContext();
      } catch (err) {
        log.warn('Re-gathering context after install failed; validating with the stale catalog', err);
      }
      state.contextDirty = false;
    }

    // Forgiving generation: deterministically add a missing start/finish and chain
    // disconnected steps in author order BEFORE compiling, so common wiring omissions the
    // model makes don't burn its repair budget (recurses into inline subflow children). Best
    // effort — a repair failure just compiles the spec as-is.
    let specToCompile: FlowSpec = spec;
    let repairChanges: RepairChange[] = [];
    try {
      const repaired = repairFlowSpec(spec);
      if (repaired.changes.length > 0) {
        specToCompile = repaired.spec;
        repairChanges = repaired.changes;
        log.info(`Attempt ${attempts}: auto-repair adjusted the spec (${repairChanges.length} change(s))`);
      }
    } catch (err) {
      log.warn('Auto-repair of the generated spec failed; compiling the spec as-is', err);
    }
    const repairIssues = repairChanges.map((c) => ({ severity: 'warning' as const, code: c.code, message: c.message }));

    const compiled = compileFlowSpec(specToCompile, context.compile, { maxDepth, maxFlows: MAX_GENERATED_FLOWS });
    if (!compiled.flow) {
      messages.push(
        { role: 'assistant', content: raw },
        { role: 'user', content: `The specification could not be compiled:\n${issueLines(compiled.issues)}\nFix these problems and re-emit the COMPLETE corrected JSON (only the JSON).` }
      );
      continue;
    }
    // Generation-only context-saving defaults (announced in the system prompt): process
    // nodes without an explicit inputMode/outputMode run scoped to the latest message and
    // hide their tool exchanges from later steps. Applied to EVERY flow in the bundle.
    for (const f of compiled.flows) applyGenerationDefaults(f);

    const perFlow: GeneratedFlowEntry[] = compiled.flows.map((f) => ({
      flow: f,
      validation: validateFlow(f, {
        models: context.compile.models,
        servers: context.validatorServers,
        serverTools: context.compile.serverTools,
      }),
    }));
    // One merged result across the WHOLE bundle (auto-repair changes + compile issues + every
    // flow's validation) drives the repair loop and the caller's error/warning counts. The
    // auto-repair warnings tell the reviewer what wiring was added for them.
    const validation = mergeIssues([...repairIssues, ...compiled.issues], {
      issues: perFlow.flatMap((p) => p.validation.issues),
      errorCount: 0,
      warningCount: 0,
      isRunnable: true,
    });
    best = { flows: perFlow, rootFlow: compiled.flow, validation };

    if (validation.errorCount === 0) break;

    log.info(`Attempt ${attempts}: bundle has ${validation.errorCount} error(s)` + (round < maxRepairs ? '; asking the model to repair' : '; repair budget exhausted'));
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

  log.info(
    `Generated draft bundle rooted at "${best.rootFlow.name}" (${best.flows.length} flow(s)) in ${attempts} attempt(s): ${best.validation.errorCount} error(s), ${best.validation.warningCount} warning(s), ${state.installedServers.length} server(s) installed`
  );
  return {
    success: true,
    flow: best.rootFlow,
    validation: best.validation,
    flows: best.flows,
    rootFlowId: best.rootFlow.id,
    attempts,
    installedServers: state.installedServers,
  };
}

// ---------------------------------------------------------------------------
// Improve an existing flow (issue #99)
// ---------------------------------------------------------------------------

export interface ImproveFlowInput {
  /**
   * The flow to revise — the CURRENT (possibly edited-but-unsaved) canvas state from the
   * FlowBuilder. Serialized to a FlowSpec via {@link flowToSpec} and shown to the model.
   */
  flow: Flow;
  /** The user's natural-language description of the changes they want. */
  description: string;
  /** Id of the configured model that will do the improving. */
  modelId: string;
  /** Repair rounds after the first attempt (default 1, capped at 2). */
  maxRepairs?: number;
  /**
   * Let the improver INSTALL MCP servers from the public registry when the requested change
   * needs a capability no configured server provides. Same third-party-code-execution risk
   * as {@link generateFlow} — strictly opt-in per request. Searching is always allowed.
   */
  allowInstall?: boolean;
}

/**
 * Revise an EXISTING flow from a natural-language change request (issue #99).
 *
 * Reuses the generate machinery (model resolve → adapter → search/install tool loop → JSON
 * extract → compile → validate → bounded repair). The current flow is serialized back into a
 * FlowSpec (`flowToSpec`) and injected into the prompt so the model reads and writes the
 * same compact DSL. Two things keep the result stable across an edit:
 *   - node identity/layout: `flowToSpec` keys each node by its id and the compile is handed a
 *     `positions` map keyed by those ids, so nodes the model leaves alone stay put; only
 *     genuinely new nodes are laid out.
 *   - flow identity: the flow being improved is excluded from the compile's flow list (so
 *     compileFlowSpec keeps its name instead of dedup-renaming it, and it can't reference
 *     itself as a subflow), and the compiled flow's id is forced back to the original.
 *
 * Single-shot and single-flow: it does NOT author nested subflows (that's generate's job).
 * The result is ALWAYS an unsaved draft — the builder applies it to the canvas for review
 * and persisting happens only through the normal save path. Everything stays backend-side;
 * the response carries only the flow + validation, never key material.
 */
export async function improveFlow(input: ImproveFlowInput): Promise<GenerateFlowResult> {
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  if (!description) {
    return { success: false, error: 'A change description is required', statusCode: 400 };
  }
  if (!input?.modelId || typeof input.modelId !== 'string') {
    return { success: false, error: 'A generator model id is required', statusCode: 400 };
  }
  const flow = input?.flow;
  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    return { success: false, error: 'A valid flow to improve is required', statusCode: 400 };
  }

  const model = await modelService.getModel(input.modelId);
  if (!model) {
    return { success: false, error: `Generator model not found: ${input.modelId}`, statusCode: 404 };
  }
  const apiKey = await modelService.resolveAndDecryptApiKey(model.ApiKey);
  if (!apiKey) {
    return { success: false, error: 'Could not resolve the generator model API key', statusCode: 500 };
  }

  const allowInstall = input.allowInstall === true;
  let context: GenerationContext = await gatherGenerationContext();
  const adapter = getCompletionAdapter(model);
  const tools = generatorTools(allowInstall);
  const state: ToolLoopState = { installedServers: [], contextDirty: false };
  const maxRepairs = Math.min(
    typeof input.maxRepairs === 'number' && input.maxRepairs >= 0 ? input.maxRepairs : DEFAULT_MAX_REPAIRS,
    MAX_REPAIRS_CAP
  );

  // Serialize the current flow to the DSL the model authors in, keyed by node id so
  // unchanged nodes keep their canvas positions after recompilation.
  const currentSpec = flowToSpec(flow);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of flow.nodes) {
    if (n?.id && n.position && typeof n.position.x === 'number' && typeof n.position.y === 'number') {
      positions[n.id] = { x: n.position.x, y: n.position.y };
    }
  }

  // The flow's own id is dropped from the compile context each round (see above): keep the
  // name, forbid self-subflow. Recomputed after any install re-gathers the context.
  const compileContextFor = (ctx: GenerationContext) => ({
    models: ctx.compile.models,
    servers: ctx.compile.servers,
    serverTools: ctx.compile.serverTools,
    flows: (ctx.compile.flows ?? []).filter((f) => f.id !== flow.id),
  });

  const userPrompt = `EXISTING FLOW (modify this — keep unchanged parts intact, and KEEP each node's "key" for any node you do NOT restructure so its canvas position is preserved):\n${JSON.stringify(
    currentSpec
  )}\n\nCHANGE REQUEST:\n${description}\n\nRe-emit the COMPLETE flow specification as a single JSON object (only the JSON), including the nodes you did not change.`;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    // Subflow authoring is off for improve (single-shot, single-flow).
    { role: 'system', content: buildSystemPrompt(context.catalog, allowInstall, false, 0) },
    { role: 'user', content: userPrompt },
  ];

  let best: { flows: GeneratedFlowEntry[]; rootFlow: Flow; validation: FlowValidationResult } | null = null;
  let attempts = 0;

  for (let round = 0; round <= maxRepairs; round++) {
    attempts++;
    let raw: string;
    try {
      raw = await runModelTurn(adapter, model, apiKey, messages, tools, allowInstall, state);
    } catch (error) {
      log.error('Improver model call failed', error);
      if (best) break;
      return {
        success: false,
        error: `The generator model call failed: ${error instanceof Error ? error.message : String(error)}`,
        statusCode: 502,
      };
    }

    // An install (if any) changed what exists — re-gather before compile/validate.
    if (state.contextDirty) {
      try {
        context = await gatherGenerationContext();
      } catch (err) {
        log.warn('Re-gathering context after install failed; using the stale catalog', err);
      }
      state.contextDirty = false;
    }

    const spec = extractJsonObject(raw) as FlowSpec | null;
    if (!spec) {
      log.warn(`Improve attempt ${attempts}: model output contained no parseable JSON object`);
      messages.push(
        { role: 'assistant', content: raw },
        { role: 'user', content: 'Your reply contained no parseable JSON object. Re-emit the COMPLETE flow specification as a single JSON object and nothing else.' }
      );
      continue;
    }

    const compiled = compileFlowSpec(spec, compileContextFor(context), { maxDepth: 0, maxFlows: 1, positions });
    if (!compiled.flow) {
      messages.push(
        { role: 'assistant', content: raw },
        { role: 'user', content: `The specification could not be compiled:\n${issueLines(compiled.issues)}\nFix these problems and re-emit the COMPLETE corrected JSON (only the JSON).` }
      );
      continue;
    }
    // The improved flow IS the flow being edited: keep its id, and keep its name if the
    // model dropped it (a nameless spec would otherwise sanitize to "generated_flow").
    compiled.flow.id = flow.id;
    if (typeof spec.name !== 'string' || !spec.name.trim()) compiled.flow.name = flow.name;
    // New nodes the model added without explicit modes get the generated-flow defaults;
    // nodes carried over already have their modes serialized, so they're untouched.
    applyGenerationDefaults(compiled.flow);

    const flowValidation = validateFlow(compiled.flow, {
      models: context.compile.models,
      servers: context.validatorServers,
      serverTools: context.compile.serverTools,
    });
    const validation = mergeIssues(compiled.issues, flowValidation);
    best = { flows: [{ flow: compiled.flow, validation: flowValidation }], rootFlow: compiled.flow, validation };

    if (validation.errorCount === 0) break;

    log.info(`Improve attempt ${attempts}: flow has ${validation.errorCount} error(s)` + (round < maxRepairs ? '; asking the model to repair' : '; repair budget exhausted'));
    if (round < maxRepairs) {
      messages.push(
        { role: 'assistant', content: raw },
        { role: 'user', content: `The flow you specified has these problems:\n${issueLines(validation.issues)}\nFix the errors (warnings are advisory) and re-emit the COMPLETE corrected JSON (only the JSON).` }
      );
    }
  }

  if (!best) {
    return {
      success: false,
      error: 'The model did not produce a usable flow specification. Try rephrasing the change request or a different generator model.',
      statusCode: 422,
    };
  }

  log.info(
    `Improved draft "${best.rootFlow.name}" in ${attempts} attempt(s): ${best.validation.errorCount} error(s), ${best.validation.warningCount} warning(s), ${state.installedServers.length} server(s) installed`
  );
  return {
    success: true,
    flow: best.rootFlow,
    validation: best.validation,
    flows: best.flows,
    rootFlowId: best.rootFlow.id,
    attempts,
    installedServers: state.installedServers,
  };
}

// ---------------------------------------------------------------------------
// AI-supported auto-repair (the "ai" mode of the flow repair feature)
// ---------------------------------------------------------------------------

export interface RepairFlowAIInput {
  /** The flow to repair — the current (possibly unsaved) canvas state. */
  flow: Flow;
  /** Id of the configured model that will do the repairing. */
  modelId: string;
  /** Let the repairer install MCP servers if a fix needs a missing capability (opt-in). */
  allowInstall?: boolean;
  /** Repair rounds after the first attempt (default 1, capped at 2). */
  maxRepairs?: number;
}

/**
 * AI-supported flow repair: the model counterpart to the deterministic {@link autoRepairFlow}
 * (in flowAutoRepair.ts). Where the static repair connects things geometrically, this reuses
 * the whole {@link improveFlow} seam (model resolve → flowToSpec → prompt → compile → bounded
 * repair, preserving node ids/positions) with a change request SYNTHESIZED from the flow's own
 * structural problems plus the same top-to-bottom = sequential / same-row = parallel intent
 * the static planner follows. It never touches node prompts/models/servers — only wiring.
 */
export async function repairFlowWithAI(input: RepairFlowAIInput): Promise<GenerateFlowResult> {
  const flow = input?.flow;
  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    return { success: false, error: 'A valid flow to repair is required', statusCode: 400 };
  }
  if (!input?.modelId || typeof input.modelId !== 'string') {
    return { success: false, error: 'A repair model id is required', statusCode: 400 };
  }

  // Structural checks need no model/server context, so they run here to sharpen the request.
  const structural = validateFlow(flow);
  const known = structural.issues.length > 0 ? `\n\nKnown problems to fix:\n${issueLines(structural.issues)}` : '';
  const description =
    `Repair this flow's wiring so it is runnable, WITHOUT changing any node's prompt, model, or servers:\n` +
    `- add a Start node if one is missing, connected to the first step;\n` +
    `- add a Finish node if one is missing, connected from the last step;\n` +
    `- connect any disconnected process/subflow nodes.\n` +
    `Read node placement as intent: nodes stacked top-to-bottom are sequential steps, and nodes on the same horizontal line are parallel branches under a shared parent above them.${known}`;

  return improveFlow({
    flow,
    description,
    modelId: input.modelId,
    ...(input.allowInstall !== undefined ? { allowInstall: input.allowInstall } : {}),
    ...(input.maxRepairs !== undefined ? { maxRepairs: input.maxRepairs } : {}),
  });
}
