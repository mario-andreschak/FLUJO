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
 *
 * The FlowSpec DSL text and the building-block catalog are shared with the non-LLM
 * authoring surfaces (POST /api/flow/compile, the MCP authoring tools) via
 * `flowSpecDoc.ts` and `generationContext.ts`, so the formats can never drift.
 */
import { createLogger } from '@/utils/logger';
import OpenAI from 'openai';
import { Flow } from '@/shared/types/flow';
import { modelService } from '@/backend/services/model';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { compileFlowSpec, FlowSpec } from '@/utils/shared/flowSpecCompiler';
import { validateFlow, FlowValidationResult } from '@/utils/shared/flowValidation';
import { FLOWSPEC_DOC } from '@/utils/shared/flowSpecDoc';
import { gatherGenerationContext, mergeIssues } from './generationContext';

const log = createLogger('backend/services/flow/generateFlow');

/** Repair rounds after the initial attempt: default / hard cap. */
const DEFAULT_MAX_REPAIRS = 1;
const MAX_REPAIRS_CAP = 2;

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
// Prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(catalog: string): string {
  return `You design workflows for FLUJO, an MCP-first workflow builder. The user describes what they want; you emit a flow specification as JSON.

OUTPUT FORMAT — respond with ONLY one JSON object, no prose, no code fences.

${FLOWSPEC_DOC}

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

  const context = await gatherGenerationContext();
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
