import type { CodexUsageLike } from './codexUsage';
import type { ModelContextUsage } from '@/shared/types/model/contextUsage';

/** Released app-server wire contract admitted by FLUJO, independent of SDK exec. */
export const CODEX_APP_SERVER_CONTRACT = 'flujo-codex-app-server-v1';
export function codexRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex protocol response.');
  return value as Record<string, unknown>;
}
export function codexId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new Error('Invalid Codex protocol identity.');
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Codex token usage.');
  return value;
}
function tokens(value: unknown): CodexUsageLike {
  const row = codexRecord(value);
  const usage: CodexUsageLike = { input_tokens: count(row.inputTokens), output_tokens: count(row.outputTokens) };
  for (const [wire, field] of [
    ['cachedInputTokens', 'cached_input_tokens'], ['cacheWriteInputTokens', 'cache_write_input_tokens'],
    ['reasoningOutputTokens', 'reasoning_output_tokens'],
  ] as const) {
    if (row[wire] != null) {
      const value = count(row[wire]);
      if (value > (wire === 'reasoningOutputTokens' ? usage.output_tokens! : usage.input_tokens!)) throw new Error('Invalid Codex token subset.');
      usage[field] = value;
    }
  }
  return usage;
}
/** Oldest CLI whose ordinary conversation path (steer, fork, deltas, usage,
 * questions) was checked end to end. Older programs lack parts of it. */
export const MIN_ORDINARY_CODEX_CLI = '0.162.1';
const SEMVER = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function olderVersion(candidate: string, minimum: string): boolean {
  const a = candidate.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
/** Thrown before any thread or turn when the running Codex is too old. */
export class CodexRuntimeVersionError extends Error {
  constructor(readonly version: string) {
    super(`This Codex program is version ${version}, but FLUJO needs version ${MIN_ORDINARY_CODEX_CLI} or newer. `
      + 'Nothing was sent to Codex. Update or reinstall FLUJO so it uses its own bundled Codex.');
    this.name = 'CodexRuntimeVersionError';
  }
}
/** The app-server names its own version in `initialize`'s userAgent, for
 * example `flujo_conversation/0.166.0 (Windows 10.0.19045; x86_64) …`.
 * Returns the version, or undefined when the server does not say. */
export function codexServerVersion(initializeResult: unknown): string | undefined {
  const agent = initializeResult && typeof initializeResult === 'object' ? (initializeResult as { userAgent?: unknown }).userAgent : undefined;
  if (typeof agent !== 'string' || agent.length > 1024) return undefined;
  const version = /^[^\s/]{1,128}\/(\d{1,3}\.\d{1,3}\.\d{1,3})(?:[-+][0-9A-Za-z.-]{1,64})?(?:\s|$)/.exec(agent)?.[1];
  return version && SEMVER.test(version) ? version : undefined;
}
/** Refuse a too-old server with a plain message. An unstated version is
 * allowed: managed updates are qualified before use, so this only guards drift. */
export function assertSupportedCodexServer(initializeResult: unknown): string | undefined {
  const version = codexServerVersion(initializeResult);
  if (version && olderVersion(version, MIN_ORDINARY_CODEX_CLI)) throw new CodexRuntimeVersionError(version);
  return version;
}

const ERROR_LEADS: Record<string, string> = {
  usageLimitExceeded: 'Your ChatGPT plan has used up its Codex allowance for now.',
  rateLimitExceeded: 'Codex is getting too many requests right now. Wait a moment, then try again.',
  sessionBudgetExceeded: 'This Codex conversation reached its spending limit.',
  unauthorized: 'Codex refused the sign-in. Sign in to Codex again under AI Setup.',
  modelNotFound: 'This model is not available to your Codex account. Pick another model under AI Setup.',
  contextWindowExceeded: 'This conversation is too long for the model. Start a new conversation or pick a model with more room.',
  serverOverloaded: 'Codex is busy right now. Try again in a few minutes.',
  internalServerError: 'Codex had a problem on its side. Try again in a few minutes.',
  badRequest: 'Codex could not accept this request.',
  cyberPolicy: 'Codex declined this request under its usage policy.',
  misalignmentPolicyViolation: 'Codex declined this request under its usage policy.',
  policyCapacityUnavailable: 'Codex cannot take this request right now. Try again later.',
};
/** Plain, bounded text for a Codex `error` notification or failed turn. The
 * provider's own message (for example the time a limit resets) is kept. */
export function describeCodexTurnError(value: unknown): string {
  const error = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const info = error.codexErrorInfo;
  const kind = typeof info === 'string' ? info
    : info && typeof info === 'object' && !Array.isArray(info) ? Object.keys(info)[0] : undefined;
  const lead = (kind && ERROR_LEADS[kind])
    ?? (kind && /connection|disconnected|failedattempts/i.test(kind) ? 'Codex lost its connection to the model service. Try again.' : undefined)
    ?? 'Codex reported an error.';
  const detail = typeof error.message === 'string' ? error.message.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
  return `${lead}${detail && detail !== lead ? ` Codex says: "${detail}"` : ''} FLUJO did not send the input again.`;
}

/** Answers for Codex's own approval prompts. FLUJO runs Codex with its own
 * shell, file edits and extra permissions switched off, and every tool goes
 * through FLUJO's MCP bridge, where FLUJO's approval setting decides. So:
 * Codex's own command, file and permission prompts are declined, and Codex's
 * approval prompt for a FLUJO tool is passed on to that FLUJO gate (accepted
 * here, then asked in the tool handler). Anything else is declined. */
export type CodexApprovalAnswer = Readonly<{ forwardToFlujoGate: boolean; result: unknown }>;
const DECLINED_BUILT_IN = 'FLUJO runs Codex without its own shell, file edits or extra permissions. Use the FLUJO tools instead.';
export const CODEX_DECLINED_ELICITATION = Object.freeze({ action: 'decline', content: null, _meta: null });
export function codexApprovalAnswer(method: string, params: Record<string, unknown>): CodexApprovalAnswer | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { forwardToFlujoGate: false, result: { decision: 'decline' } };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { forwardToFlujoGate: false, result: { decision: { denied: { rejection: DECLINED_BUILT_IN } } } };
    case 'item/permissions/requestApproval':
      // Granting an empty set is the protocol's refusal: nothing is added.
      return { forwardToFlujoGate: false, result: { permissions: {}, scope: 'turn' } };
    case 'item/tool/call':
      return { forwardToFlujoGate: false, result: { success: false, contentItems: [{ type: 'inputText', text: DECLINED_BUILT_IN }] } };
    case 'mcpServer/elicitation/request': {
      const meta = params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta)
        ? params._meta as Record<string, unknown> : {};
      if (params.serverName === 'flujo' && params.mode === 'form' && meta.codex_approval_kind === 'mcp_tool_call') {
        return { forwardToFlujoGate: true, result: { action: 'accept', content: {}, _meta: null } };
      }
      return { forwardToFlujoGate: false, result: CODEX_DECLINED_ELICITATION };
    }
    default:
      return undefined;
  }
}

export function parseCodexProtocolUsage(value: unknown): { total: CodexUsageLike; context: ModelContextUsage } {
  const row = codexRecord(value);
  const total = tokens(row.total), last = tokens(row.last);
  return { total, context: {
    promptTokens: last.input_tokens!, completionTokens: last.output_tokens!,
    totalTokens: last.input_tokens! + last.output_tokens!,
    ...(row.modelContextWindow != null && count(row.modelContextWindow) > 0
      ? { contextWindow: count(row.modelContextWindow), contextWindowSource: 'runtime' as const } : {}),
  } };
}
