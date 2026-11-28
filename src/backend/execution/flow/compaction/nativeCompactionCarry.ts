import type OpenAI from 'openai';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { classifyStandingInstruction, userText } from './standingInstructions';
import { executionReceiptBlock } from '../handlers/summarizingCompaction';

/** Room the carry may take, so it never crowds out the compacted history. */
const MAX_CARRY_CHARS = 64_000;
export const NATIVE_COMPACTION_CARRY_HEADING = '[FLUJO context kept after compaction]';

export interface NativeCompactionCarry {
  text: string;
  /** False when some instructions or receipts did not fit. The runtime's
   * thread then lacks them, so FLUJO rebuilds the next turn from its own
   * compaction instead of reusing that thread. */
  complete: boolean;
}

/** The parts of a wire message the instruction and receipt rules read. */
function asChatMessage(message: OpenAI.ChatCompletionMessageParam, index: number): FlujoChatMessage {
  const base = { id: 'id' in message && typeof message.id === 'string' ? message.id : `wire-${index}`, timestamp: 0,
    ...('injected' in message && message.injected === true ? { injected: true } : {}) };
  switch (message.role) {
    case 'assistant': {
      const calls = message.tool_calls?.filter((call): call is OpenAI.ChatCompletionMessageFunctionToolCall => call.type === 'function');
      return { ...base, role: 'assistant', content: typeof message.content === 'string' ? message.content : null,
        ...(calls?.length ? { tool_calls: calls } : {}) };
    }
    case 'tool':
      return { ...base, role: 'tool', tool_call_id: message.tool_call_id, content: typeof message.content === 'string' ? message.content : '' };
    case 'user':
      return { ...base, role: 'user', content: message.content };
    default:
      return { ...base, role: 'system', content: typeof message.content === 'string' ? message.content : '' };
  }
}

/**
 * What FLUJO sends again when a model runtime replaces earlier turns with a
 * summary of its own (Codex's native compaction). That summary is written by
 * the model alone, so FLUJO's compaction rules (#1091) apply on top of it:
 * every user turn that sets a standing instruction comes back word for word,
 * and every tool call that already ran comes back as an exact receipt.
 * Returns undefined when there is nothing to keep.
 */
export function nativeCompactionCarry(wire: readonly OpenAI.ChatCompletionMessageParam[]): NativeCompactionCarry | undefined {
  const messages = wire.map(asChatMessage);
  let receipts = executionReceiptBlock(messages);
  let complete = true;
  if (receipts.length > MAX_CARRY_CHARS / 2) {
    receipts = executionReceiptBlock(messages, MAX_CARRY_CHARS / 2);
    complete = false;
  }
  const instructions = messages.filter(message => classifyStandingInstruction(message))
    .map(message => userText(message).trim()).filter(Boolean);
  if (!instructions.length && !receipts) return undefined;
  // Newest instructions win the room; an older one left out makes the carry incomplete.
  let budget = MAX_CARRY_CHARS - receipts.length, first = instructions.length;
  while (first > 0 && instructions[first - 1].length + 8 <= budget) budget -= instructions[--first].length + 8;
  if (first) complete = false;
  const kept = instructions.slice(first).map((text, index) => `${index + 1}. ${text}`);
  const text = [
    NATIVE_COMPACTION_CARRY_HEADING,
    'Earlier turns were replaced by a summary. These are FLUJO\'s exact records and they win over that summary. This is not a new request: carry on with the current task.',
    ...(kept.length ? ['', '## Standing user instructions (word for word, oldest first)', ...kept] : []),
  ].join('\n') + receipts;
  return { text, complete };
}
