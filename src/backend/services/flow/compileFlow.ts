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
 * flows always get a fresh uuid, so saving is always a create, never an overwrite
 * (updates remain the builder's job in v1 — a spec cannot express manual canvas edits).
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
  flow: Flow;
  /** Shared-validator result with compile issues merged in. */
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
  options: { save?: boolean } = {}
): Promise<CompileSpecResult> {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { success: false, error: 'The spec must be a JSON object (a FlowSpec)', statusCode: 400 };
  }

  const context = await gatherGenerationContext();
  const compiled = compileFlowSpec(spec as FlowSpec, context.compile);

  if (!compiled.flow) {
    return {
      success: false,
      error: 'The spec could not be compiled into a flow',
      statusCode: 422,
      issues: compiled.issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message })),
    };
  }

  const validation = mergeIssues(
    compiled.issues,
    validateFlow(compiled.flow, {
      models: context.compile.models,
      servers: context.validatorServers,
      serverTools: context.compile.serverTools,
    })
  );

  let saved = false;
  if (options.save && validation.errorCount === 0) {
    await flowService.saveFlow(compiled.flow);
    saved = true;
    log.info(`Compiled and saved flow "${compiled.flow.name}" (${compiled.flow.id})`);
  } else if (options.save) {
    log.info(`Compiled flow "${compiled.flow.name}" has ${validation.errorCount} error(s); NOT saved`);
  }

  return { success: true, flow: compiled.flow, validation, saved };
}
