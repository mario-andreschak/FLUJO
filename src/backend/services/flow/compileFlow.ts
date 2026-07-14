/**
 * Deterministic FlowSpec compilation as a public authoring operation (#14 follow-up).
 *
 * The no-LLM sibling of generateFlow: an external caller (typically itself an AI app,
 * via POST /api/flow/compile or the built-in MCP server's authoring tools) authors a
 * FlowSpec directly and gets back the compiled Flow + validation — instant, free, and
 * deterministic. This makes FlowSpec the stable public contract for programmatic flow
 * creation; raw ReactFlow JSON (POST /api/flow) stays the internal/advanced surface.
 *
 * Save semantics: opt-in (`save: true`) and gated on ZERO validation errors — an agent
 * iterates spec → issues → fixed spec until clean, then the save goes through. Compiled
 * flows always get a fresh uuid, so saving is always a create, never an overwrite —
 * UNLESS `updateFlowId` targets an existing flow: then the compiled (root) flow takes
 * over that id and the save REPLACES the flow's whole definition (references by id —
 * planned executions, subflow nodes, conversations — keep working; manual canvas edits
 * are lost, since a spec cannot express them).
 *
 * Multi-level (#94): a spec may nest inline child flows via `subflowSpec`, so compilation
 * yields a BUNDLE (root + descendants). Validation covers every flow in the bundle, and a
 * clean save persists them descendants-first (so each subflowId resolves the moment its
 * parent is saved). `flow` is the root; `flows` is the whole bundle.
 */
import { createLogger } from '@/utils/logger';
import { Flow } from '@/shared/types/flow';
import { flowService } from '@/backend/services/flow';
import { compileFlowSpec, FlowSpec } from '@/utils/shared/flowSpecCompiler';
import { validateFlow, FlowValidationResult } from '@/utils/shared/flowValidation';
import { gatherGenerationContext, mergeIssues } from './generationContext';

const log = createLogger('backend/services/flow/compileFlow');

export interface CompileSpecSuccess {
  success: true;
  /** The ROOT flow. */
  flow: Flow;
  /** The full bundle (root + inline-subflow descendants), dependency order (descendants first). */
  flows: Flow[];
  /** Shared-validator result with compile issues merged in (covers the WHOLE bundle). */
  validation: FlowValidationResult;
  /** True when `save` was requested AND validation found zero errors. */
  saved: boolean;
}

export interface CompileSpecFailure {
  success: false;
  error: string;
  statusCode: number;
  /** Compile issues, when the spec produced no usable flow at all. */
  issues?: Array<{ severity: string; code: string; message: string }>;
}

export type CompileSpecResult = CompileSpecSuccess | CompileSpecFailure;

export async function compileSpec(
  spec: unknown,
  options: { save?: boolean; updateFlowId?: string } = {}
): Promise<CompileSpecResult> {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { success: false, error: 'The spec must be a JSON object (a FlowSpec)', statusCode: 400 };
  }

  const context = await gatherGenerationContext();
  let compileContext = context.compile;
  if (options.updateFlowId) {
    const flows = compileContext.flows ?? [];
    if (!flows.some((f) => f.id === options.updateFlowId)) {
      return { success: false, error: `No flow with id "${options.updateFlowId}" to update`, statusCode: 404 };
    }
    // Compile as if the target flow did not exist: its own name must not trip
    // the name-dedup rename (keeping the name would yield "name_2"), and a
    // subflow reference to the flow being replaced would recurse into itself.
    compileContext = { ...compileContext, flows: flows.filter((f) => f.id !== options.updateFlowId) };
  }
  const compiled = compileFlowSpec(spec as FlowSpec, compileContext);

  if (!compiled.flow) {
    return {
      success: false,
      error: 'The spec could not be compiled into a flow',
      statusCode: 422,
      issues: compiled.issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message })),
    };
  }

  // Take over the target's id BEFORE validate/save so the result (and the
  // saveFlow upsert) consistently carry the surviving id. Only the ROOT flow
  // adopts the target id; inline-subflow descendants are always fresh creates.
  if (options.updateFlowId) {
    compiled.flow.id = options.updateFlowId;
  }

  // Validate every flow in the bundle and merge all issues into one result so the
  // agent-facing loop sees problems in nested children too, not just the root.
  const perFlowIssues = compiled.flows.flatMap((f) =>
    validateFlow(f, {
      models: context.compile.models,
      servers: context.validatorServers,
      serverTools: context.compile.serverTools,
    }).issues
  );
  const validation = mergeIssues(compiled.issues, {
    issues: perFlowIssues,
    errorCount: 0,
    warningCount: 0,
    isRunnable: true,
  });

  let saved = false;
  if (options.save && validation.errorCount === 0) {
    // Descendants first (compiled.flows is dependency-ordered), then the root, so a
    // subflowId is always resolvable by the time its parent lands.
    for (const f of compiled.flows) {
      await flowService.saveFlow(f);
    }
    saved = true;
    log.info(`Compiled and saved ${compiled.flows.length} flow(s); root "${compiled.flow.name}" (${compiled.flow.id})`);
  } else if (options.save) {
    log.info(`Compiled flow "${compiled.flow.name}" has ${validation.errorCount} error(s); NOT saved`);
  }

  return { success: true, flow: compiled.flow, flows: compiled.flows, validation, saved };
}
