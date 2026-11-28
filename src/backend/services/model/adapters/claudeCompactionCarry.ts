// After Claude Code compacts its own session, FLUJO's standing instructions and exact receipts go back in (#1091).
import type OpenAI from 'openai';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { nativeCompactionCarry } from '@/backend/execution/flow/compaction/nativeCompactionCarry';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/model/adapters/claudeCompactionCarry');

/**
 * Claude Code summarizes its session by itself when the window fills, and
 * that summary is written by the model alone. Its `SessionStart` hook fires
 * with source "compact" right after; FLUJO's exact records go back in there
 * as additional context, the same carry Codex gets after its own compaction.
 * `onIncomplete` runs when some records did not fit, so the caller can drop
 * the session and rebuild the next turn from FLUJO's own history.
 */
export function claudeCompactionCarryHook(
  wire: () => readonly OpenAI.ChatCompletionMessageParam[],
  onIncomplete: () => void,
): HookCallback {
  return async input => {
    if (input.hook_event_name !== 'SessionStart' || input.source !== 'compact') return {};
    const carry = nativeCompactionCarry(wire());
    if (!carry) return {};
    if (!carry.complete) onIncomplete();
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: carry.text } };
  };
}

/** Claude Code's own record of a compaction, logged so its cost is measured too. */
export function logClaudeCompaction(message: unknown): void {
  const boundary = message as { type?: string; subtype?: string; compact_metadata?: Record<string, unknown> };
  if (boundary?.type !== 'system' || boundary.subtype !== 'compact_boundary') return;
  const metadata = boundary.compact_metadata ?? {};
  log.info('Claude Code compacted its session; FLUJO records went back in after it', {
    trigger: metadata.trigger,
    preTokens: metadata.pre_tokens,
    postTokens: metadata.post_tokens,
    durationMs: metadata.duration_ms,
  });
}
