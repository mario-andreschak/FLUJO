// Anthropic's on-demand compaction (beta compact-2026-09-04): one request returns a signed summary, which goes back unchanged.
import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicCompactionRecord, ModelProviderMetadata } from '@/shared/types/openai';
import { COMPACTION_SUMMARY_MARKER } from '@/backend/execution/flow/handlers/summarizingCompaction';

/** https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand */
export const ANTHROPIC_COMPACTION_BETA = 'compact-2026-09-04';

/** One compaction call's room for the model's thinking and the summary together. */
export const ANTHROPIC_COMPACTION_MAX_TOKENS = 16_000;

/**
 * How long a model whose endpoint refused native compaction uses FLUJO's own
 * summary instead. After that the next compaction tries the native one again,
 * so a gateway that learns the feature, or a passing fault, needs no restart.
 */
export const NATIVE_COMPACTION_RETRY_MS = 30 * 60_000;

const refusedUntil = new Map<string, number>();

/** False while a recent refusal sends this model to FLUJO's own summary. */
export function anthropicCompactionAvailable(modelId: string, now = Date.now()): boolean {
  const until = refusedUntil.get(modelId);
  if (until === undefined) return true;
  if (now < until) return false;
  refusedUntil.delete(modelId);
  return true;
}

export function markAnthropicCompactionRefused(modelId: string, now = Date.now()): void {
  refusedUntil.set(modelId, now + NATIVE_COMPACTION_RETRY_MS);
}

/** Test seam: forget every refusal. */
export function __resetAnthropicCompactionSupport(): void {
  refusedUntil.clear();
}

/** The call ended without a summary: cut off, refused, a tool call or no text. */
export class AnthropicCompactionMissingError extends Error {
  readonly code = 'native_compaction_missing';

  constructor(readonly stopReason: string | null) {
    super(`Anthropic returned no compaction summary (stop_reason ${stopReason ?? 'none'}).`);
    this.name = 'AnthropicCompactionMissingError';
  }
}

/** The signed block of a compaction response, copied field for field. */
export function compactionRecordOf(message: Anthropic.Message | Anthropic.Beta.BetaMessage, model: string): AnthropicCompactionRecord {
  const content: ReadonlyArray<{ type: string }> = message.content;
  const blocks = content.filter((block): block is Anthropic.Beta.BetaCompactionBlock => block.type === 'compaction');
  const block = blocks[0];
  const stopReason: string | null = message.stop_reason;
  if (stopReason !== 'compaction' || blocks.length !== 1 || typeof block.content !== 'string' || !block.content.trim()) {
    throw new AnthropicCompactionMissingError(stopReason);
  }
  return { model, block: { ...block, type: 'compaction', content: block.content } };
}

type IterationUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/**
 * Tokens of a compaction call. The top-level counts are zero there; the call
 * is reported, and billed, in `usage.iterations`.
 */
export function compactionUsage(usage: Anthropic.Usage | Anthropic.Beta.BetaUsage): {
  input: number; output: number; cacheRead: number; cacheWrite: number;
} {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const iterations: ReadonlyArray<IterationUsage> = ('iterations' in usage ? usage.iterations : undefined) ?? [];
  for (const iteration of iterations) {
    totals.input += iteration.input_tokens ?? 0;
    totals.output += iteration.output_tokens ?? 0;
    totals.cacheRead += iteration.cache_read_input_tokens ?? 0;
    totals.cacheWrite += iteration.cache_creation_input_tokens ?? 0;
  }
  return totals;
}

/**
 * A refusal of the feature itself: an endpoint, model or gateway that does not
 * know it, or a block it would not take back. Never an overload or a dropped
 * connection, which `isTransientCompactionFailure` covers.
 */
export function isCompactionRefusal(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 400 && status !== 404 && status !== 422) return false;
  const haystack = [
    (err as { message?: string })?.message,
    JSON.stringify((err as { error?: unknown })?.error ?? ''),
  ].join(' ').toLowerCase();
  return haystack.includes('compaction') || haystack.includes('compact-2026') || haystack.includes('anthropic-beta');
}

/** Overload, rate limit, a dropped connection or Stop: try native compaction again next time. */
export function isTransientCompactionFailure(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIUserAbortError) return true;
  if ((err as { name?: string })?.name === 'AbortError') return true;
  const status = (err as { status?: number })?.status;
  return status === 408 || status === 409 || status === 429 || (typeof status === 'number' && status >= 500);
}

/**
 * The records FLUJO keeps after a native summary (exact observations,
 * receipts, archive pointer), or undefined when the message no longer starts
 * with the summary the block holds. Then the whole text goes as plain text.
 */
export function textAfterCompaction(text: string, record: AnthropicCompactionRecord): string | undefined {
  const head = COMPACTION_SUMMARY_MARKER + '\n\n' + record.block.content;
  return text.startsWith(head) ? text.slice(head.length).trim() : undefined;
}

/** The record a wire message carries, if any. */
export function compactionRecordOfMessage(message: unknown): AnthropicCompactionRecord | undefined {
  const metadata = (message as { providerMetadata?: ModelProviderMetadata } | undefined)?.providerMetadata;
  const record = metadata?.anthropicCompaction;
  return record && record.block?.type === 'compaction' && typeof record.block.content === 'string' ? record : undefined;
}

/**
 * Puts the signed block first in `messages`, as the first block of the opening
 * assistant turn. `merged` says that opening turn holds the records FLUJO
 * keeps after the summary; otherwise the block is an assistant turn of its own.
 */
export function placeCompactionBlock(
  messages: Anthropic.MessageParam[],
  compaction: { record: AnthropicCompactionRecord; merged: boolean },
  cache: boolean,
): Anthropic.Beta.BetaMessageParam[] {
  const signed = compaction.record.block as Anthropic.Beta.BetaCompactionBlockParam;
  // The documented way to cache everything up to and including the summary.
  const block: Anthropic.Beta.BetaCompactionBlockParam = cache ? { ...signed, cache_control: { type: 'ephemeral' } } : signed;
  if (!compaction.merged) return [{ role: 'assistant', content: [block] }, ...messages];
  const [first, ...rest] = messages;
  const content: Anthropic.Beta.BetaContentBlockParam[] = typeof first.content === 'string'
    ? [{ type: 'text', text: first.content }]
    : first.content;
  return [{ role: 'assistant', content: [block, ...content] }, ...rest];
}
