import { createLogger } from '@/utils/logger';
import { RUN_RESOURCE_SCHEME } from '@/shared/types/runResources';
import type { FlujoChatMessage } from '@/shared/types/chat';

const log = createLogger('backend/execution/flow/handlers/summarizingCompaction');

/**
 * Summarizing compaction (issue #248) — anchored session summary + re-run turn.
 *
 * FLUJO's existing `compactForWire` is a WIRE-ONLY shrink: it truncates old
 * oversized tool results (behind `flujo://run/...` URIs) and drops old
 * assistant prose on the outgoing request, but never mutates the persisted
 * `SharedState.messages`. When a long agentic run finally exceeds the context
 * window there is no "summarize and continue" path — only a single emergency
 * lossy refit of the wire.
 *
 * This module implements a real, PERSISTED summarizing compaction modelled on
 * opencode's `compaction.ts`:
 *   - an anchored-summary template (Objective / Important Details / Work State /
 *     Next Move / Relevant Files) the model fills in;
 *   - UPDATE-the-previous-summary semantics so repeated compactions don't
 *     degrade into a summary-of-a-summary;
 *   - the summary becomes the new HEAD of the persisted conversation;
 *   - `flujo://run/...` URIs referenced by the summarized slice are preserved so
 *     they stay dereferenceable via `read_resource`.
 *
 * Everything here is pure / dependency-injected (the model call, the anchor
 * write, the clock and the id source are all injected), so the orchestration is
 * unit-testable in isolation without touching a real provider or the store.
 */

/** Marker prefixed to a compaction summary message so a later compaction can
 *  recognise its own previous summary and UPDATE it instead of summarizing a
 *  summary. Also excluded from the summarizable slice cheaply by identity. */
export const COMPACTION_SUMMARY_MARKER = '[FLUJO conversation summary]';

/** The anchored-summary section headings, always present (even when empty). */
export const COMPACTION_SUMMARY_SECTIONS = [
  '## Objective',
  '## Important Details',
  '## Work State',
  '## Next Move',
  '## Relevant Files',
] as const;

/** Rough token estimate (no real tokenizer in the codebase; char/4 heuristic,
 *  matching `chatCompletionService.countTokens`). */
export function estimateMessageTokens(m: FlujoChatMessage): number {
  let chars = 0;
  try {
    chars = JSON.stringify(m).length;
  } catch {
    chars = typeof m.content === 'string' ? m.content.length : 0;
  }
  return Math.ceil(chars / 4);
}

export function estimateTokens(messages: FlujoChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

export interface BuildCompactionPromptOptions {
  /** When set, the model UPDATES this previous summary (preserve still-true
   *  details, drop stale ones, merge in new facts) rather than starting fresh. */
  previousSummary?: string;
}

/**
 * Build the anchored-summary system+user prompt. Adopts opencode's template:
 * terse bullets, verbatim preservation of exact paths / symbols / commands /
 * error strings, never mention that compaction happened, and always emit all
 * sections even when empty.
 */
export function buildCompactionPrompt(opts?: BuildCompactionPromptOptions): {
  system: string;
  user: string;
} {
  const sections = COMPACTION_SUMMARY_SECTIONS.join('\n');
  const system =
    'You are compacting a long agentic conversation into a compact, loss-minimising ' +
    'anchor the assistant will continue from. Produce ONLY the summary in the exact ' +
    'section structure below — no preamble, no closing remarks, and NEVER mention that ' +
    'the conversation was summarized or compacted.\n\n' +
    'Sections (always output all of them, even if a section is empty):\n' +
    `${sections}\n\n` +
    'Rules:\n' +
    '- Use terse bullet points.\n' +
    '- Preserve EXACT file paths, symbol names, shell commands, URLs, IDs and error ' +
    'strings VERBATIM — never paraphrase or abbreviate them.\n' +
    '- "Work State" has three labelled groups: Completed / Active / Blocked.\n' +
    '- "Relevant Files" lists paths touched or referenced, one per line.\n' +
    '- Keep any `flujo://run/...` resource URIs verbatim so they remain readable.';

  let user: string;
  if (opts?.previousSummary && opts.previousSummary.trim().length > 0) {
    user =
      'A previous summary of the earlier part of this conversation is provided below. ' +
      'UPDATE it: preserve details that are still true, remove details that are now ' +
      'stale, and merge in new facts from the conversation that follows. Do NOT ' +
      'summarize the summary — produce a single coherent, up-to-date anchor.\n\n' +
      `<previous-summary>\n${opts.previousSummary}\n</previous-summary>\n\n` +
      'Now produce the updated summary for the conversation up to this point.';
  } else {
    user = 'Summarize the conversation up to this point into the section structure above.';
  }
  return { system, user };
}

/** True when a message is a prior compaction summary head. */
export function isCompactionSummary(m: FlujoChatMessage): boolean {
  return (
    m.role === 'assistant' &&
    typeof m.content === 'string' &&
    m.content.startsWith(COMPACTION_SUMMARY_MARKER)
  );
}

export interface SplitResult {
  /** Old, top-level, summarizable messages (never includes system or depth>0). */
  toSummarize: FlujoChatMessage[];
  /** Leading system message(s), kept verbatim at the very front. */
  leadingSystem: FlujoChatMessage[];
  /** depth>0 subflow display-only messages from the old slice, kept verbatim. */
  preservedSubflow: FlujoChatMessage[];
  /** The recent tail kept verbatim. */
  toKeep: FlujoChatMessage[];
  /** Text of a previous compaction summary found in the summarizable slice. */
  previousSummary?: string;
}

/**
 * Determine the compaction boundary: keep the most recent ~`keepTokens` worth of
 * messages verbatim and summarize everything older. The boundary is rounded
 * OUTWARD (keep more) so it never splits an assistant `tool_calls` turn from its
 * `role:'tool'` results — a shape every provider rejects. Leading system
 * messages and depth>0 subflow steps are never summarized.
 */
export function splitHistoryForCompaction(
  messages: FlujoChatMessage[],
  keepTokens: number,
): SplitResult {
  const empty: SplitResult = { toSummarize: [], leadingSystem: [], preservedSubflow: [], toKeep: messages };
  if (messages.length === 0) return empty;

  // Walk from the end accumulating tokens until we reach the keep budget.
  let acc = 0;
  let k = messages.length; // first KEPT index
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i]);
    k = i;
    if (acc >= keepTokens) break;
  }
  // If the whole history fits the keep budget there is nothing to summarize.
  if (k <= 0 && acc < keepTokens) return empty;

  // Round the boundary OUTWARD so a tool group (assistant tool_calls + its
  // trailing tool results) is never split across the boundary.
  while (k > 0) {
    const cur = messages[k];
    const prev = messages[k - 1];
    const prevHasCalls =
      prev.role === 'assistant' &&
      Array.isArray((prev as { tool_calls?: unknown[] }).tool_calls) &&
      ((prev as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0;
    if (cur.role === 'tool' || prevHasCalls) {
      k--;
    } else {
      break;
    }
  }

  const oldSlice = messages.slice(0, k);
  const toKeep = messages.slice(k);

  const leadingSystem: FlujoChatMessage[] = [];
  const preservedSubflow: FlujoChatMessage[] = [];
  const toSummarize: FlujoChatMessage[] = [];
  let previousSummary: string | undefined;

  for (const m of oldSlice) {
    if (m.role === 'system') {
      leadingSystem.push(m);
      continue;
    }
    if ((m.depth ?? 0) > 0) {
      preservedSubflow.push(m);
      continue;
    }
    if (isCompactionSummary(m) && typeof m.content === 'string') {
      previousSummary = m.content.slice(COMPACTION_SUMMARY_MARKER.length).trim();
    }
    toSummarize.push(m);
  }

  return { toSummarize, leadingSystem, preservedSubflow, toKeep, previousSummary };
}

/**
 * Ensure every `flujo://run/...` URI referenced by the summarized slice survives
 * into the summary text (so the captured tool results stay dereferenceable via
 * `read_resource` after their originating messages are gone). Appends a
 * "Preserved resources" block for any URI not already present in the summary.
 */
export function preserveResourceUris(
  summaryText: string,
  summarizedMessages: FlujoChatMessage[],
): string {
  const uriRe = new RegExp(`${RUN_RESOURCE_SCHEME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\w./-]+`, 'g');
  const found = new Set<string>();
  for (const m of summarizedMessages) {
    let serialized = '';
    try {
      serialized = JSON.stringify(m);
    } catch {
      serialized = typeof m.content === 'string' ? m.content : '';
    }
    const matches = serialized.match(uriRe);
    if (matches) for (const u of matches) found.add(u);
  }
  if (found.size === 0) return summaryText;

  const missing = [...found].filter((u) => !summaryText.includes(u));
  if (missing.length === 0) return summaryText;

  const block =
    '\n\n## Preserved Resources\n' +
    missing.map((u) => `- ${u} (call read_resource with this uri to read the full content)`).join('\n');
  return summaryText + block;
}

export interface CompactHistoryOptions {
  /** Recent-tail budget kept verbatim (tokens). */
  keepTokens: number;
  /** Owning process node id, stamped onto the summary head for projection. */
  nodeId?: string;
}

export interface CompactHistoryDeps {
  /** Calls the summarization model. Returns the summary body (no marker). */
  summarize: (
    messages: FlujoChatMessage[],
    prompt: { system: string; user: string },
  ) => Promise<string>;
  /** Persist the pre-summary slice as a run resource for recoverability; returns
   *  its `flujo://run/...` URI (or undefined on failure/skip). Optional. */
  writeAnchor?: (text: string) => Promise<string | undefined>;
  now?: () => number;
  uuid?: () => string;
}

export interface CompactHistoryResult {
  /** The new summary message that becomes the conversation head. */
  summaryMessage: FlujoChatMessage;
  /** ids of the messages replaced by the summary (to emit `message:removed`). */
  removedIds: string[];
  /** The fully rebuilt message array to assign to `state.messages`. */
  newMessages: FlujoChatMessage[];
}

/**
 * Orchestrate a summarizing compaction over a message array.
 *
 * Returns `null` (a no-op — caller falls back to existing behaviour) when there
 * is nothing old enough to summarize, or when the model returns an empty/failed
 * summary (a bad summary is NEVER persisted). Otherwise returns the new summary
 * head, the ids it replaces, and the rebuilt array. The caller owns persistence
 * (log events + snapshot) so this stays pure and testable.
 */
export async function compactHistory(
  messages: FlujoChatMessage[],
  opts: CompactHistoryOptions,
  deps: CompactHistoryDeps,
): Promise<CompactHistoryResult | null> {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());

  const split = splitHistoryForCompaction(messages, opts.keepTokens);
  if (split.toSummarize.length === 0) {
    log.debug('compactHistory: nothing old enough to summarize; no-op');
    return null;
  }

  const prompt = buildCompactionPrompt({ previousSummary: split.previousSummary });

  let summaryBody: string;
  try {
    summaryBody = (await deps.summarize(split.toSummarize, prompt))?.trim() ?? '';
  } catch (error) {
    log.warn('compactHistory: summarization model call failed; falling back (no mutation)', error);
    return null;
  }
  if (!summaryBody) {
    log.warn('compactHistory: empty summary returned; falling back (no mutation)');
    return null;
  }

  // Preserve dereferenceable resource URIs from the summarized slice.
  summaryBody = preserveResourceUris(summaryBody, split.toSummarize);

  // Capture the pre-summary slice as a run resource for recoverability and embed
  // its URI in the head so nothing is silently destroyed. Best-effort.
  let anchorUri: string | undefined;
  if (deps.writeAnchor) {
    try {
      const anchorText = JSON.stringify(
        split.toSummarize.map((m) => ({ role: m.role, content: m.content, tool_calls: (m as { tool_calls?: unknown }).tool_calls })),
      );
      anchorUri = await deps.writeAnchor(anchorText);
    } catch (error) {
      log.warn('compactHistory: failed to capture pre-summary anchor resource; continuing', error);
    }
  }

  const anchorLine = anchorUri
    ? `\n\n_(Earlier turns compacted; full pre-summary history preserved at ${anchorUri}.)_`
    : '';

  const summaryMessage: FlujoChatMessage = {
    id: uuid(),
    role: 'assistant',
    content: `${COMPACTION_SUMMARY_MARKER}\n\n${summaryBody}${anchorLine}`,
    timestamp: now(),
    ...(opts.nodeId !== undefined ? { processNodeId: opts.nodeId } : {}),
  } as FlujoChatMessage;

  const newMessages: FlujoChatMessage[] = [
    ...split.leadingSystem,
    summaryMessage,
    ...split.preservedSubflow,
    ...split.toKeep,
  ];
  const removedIds = split.toSummarize.map((m) => m.id);

  log.info('compactHistory: built summary head', {
    summarized: split.toSummarize.length,
    kept: split.toKeep.length,
    updatedPrevious: Boolean(split.previousSummary),
    anchorUri: anchorUri ?? null,
  });

  return { summaryMessage, removedIds, newMessages };
}
