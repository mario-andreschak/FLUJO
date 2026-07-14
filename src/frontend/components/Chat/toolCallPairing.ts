/**
 * Pure pairing of assistant tool calls with their matching tool-result messages
 * (issue #95). The chat wire/persistence model keeps an assistant turn's
 * `tool_calls[]` in one message and each result as a separate `role: 'tool'`
 * message keyed by `tool_call_id`. To render the two as a single expandable
 * timeline unit, the UI needs, per assistant message, the ordered list of its
 * (non-handoff) tool calls paired with the result that answered each one.
 *
 * This module is intentionally free of React/MUI so it can be unit-tested in
 * the node-env Jest harness and so `ChatMessages` can memoize one pairing pass
 * per `messages` change instead of recomputing inside every memoized bubble.
 *
 * Handoff tool calls (`handoff_to_*`) are excluded here — they keep their slim
 * "Handoff → Target" marker rendering and their `{handoff:true}` result blob is
 * suppressed elsewhere.
 */

import type OpenAI from 'openai';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { HANDOFF_TOOL_PREFIX } from '@/shared/utils/handoffNaming';

/** A single assistant tool call paired with the tool result that answered it (if any yet). */
export interface ToolCallPair<TMessage extends FlujoChatMessage = FlujoChatMessage> {
  toolCall: OpenAI.ChatCompletionMessageToolCall;
  /** The matching `role: 'tool'` message, or undefined while the result is still pending. */
  result?: TMessage;
}

export interface ToolCallPairing<TMessage extends FlujoChatMessage = FlujoChatMessage> {
  /** For each assistant message id, its ordered non-handoff tool-call/result pairs. */
  pairsByMessageId: Map<string, ToolCallPair<TMessage>[]>;
  /**
   * `tool_call_id`s that belong to an assistant call rendered as a timeline in
   * this pass. Their standalone `role: 'tool'` bubbles must be skipped by the
   * list loop (the result is shown inside the timeline instead). A tool result
   * whose id is NOT in this set is an orphan (parent call outside the render
   * window / missing) and keeps its legacy standalone bubble.
   */
  consumedToolCallIds: Set<string>;
}

/** True when a tool function name is a handoff (matches the runtime prefix). */
function isHandoffToolName(name?: string): boolean {
  return !!name && (name.startsWith(HANDOFF_TOOL_PREFIX) || name === 'handoff');
}

/**
 * Pair every assistant message's non-handoff tool calls with their result
 * messages, matched by `tool_call_id`.
 *
 * - Pairing is order-independent: results that stream in later (or arrive out
 *   of order) are picked up on the next call because the whole `messages` array
 *   is re-scanned.
 * - A tool call with no result yet yields `{ toolCall, result: undefined }`
 *   (rendered as "pending").
 * - Every non-handoff tool call that has an id is added to
 *   `consumedToolCallIds` regardless of whether its result has arrived, so the
 *   result bubble is suppressed the moment it appears.
 */
export function pairToolCallsWithResults<TMessage extends FlujoChatMessage>(
  messages: TMessage[]
): ToolCallPairing<TMessage> {
  const pairsByMessageId = new Map<string, ToolCallPair<TMessage>[]>();
  const consumedToolCallIds = new Set<string>();

  if (!Array.isArray(messages)) {
    return { pairsByMessageId, consumedToolCallIds };
  }

  // 1. Index tool results by their tool_call_id (first result wins on the rare
  //    chance of a duplicate id).
  const resultByToolCallId = new Map<string, TMessage>();
  for (const message of messages) {
    if (
      message.role === 'tool' &&
      typeof message.tool_call_id === 'string' &&
      message.tool_call_id &&
      !resultByToolCallId.has(message.tool_call_id)
    ) {
      resultByToolCallId.set(message.tool_call_id, message);
    }
  }

  // 2. Build the per-assistant-message pairs.
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const toolCalls = message.tool_calls;
    if (!Array.isArray(toolCalls)) continue;

    const pairs: ToolCallPair<TMessage>[] = [];
    for (const toolCall of toolCalls) {
      // Only function tool calls carry a `.function.name`; skip handoffs.
      if (toolCall.type !== 'function' || isHandoffToolName(toolCall.function?.name)) {
        continue;
      }
      const id = toolCall.id;
      const result = id ? resultByToolCallId.get(id) : undefined;
      if (id) consumedToolCallIds.add(id);
      pairs.push({ toolCall, result });
    }

    if (pairs.length > 0) {
      pairsByMessageId.set(message.id, pairs);
    }
  }

  return { pairsByMessageId, consumedToolCallIds };
}

/**
 * #95 (follow-up): a contiguous-assistant-run grouping of tool calls onto a
 * single anchor bubble. The Claude-subscription adapter records a tool-using
 * turn as SEPARATE messages — a narration message, then one `content: ''`
 * assistant message per tool call (each followed by its `tool` result) — so each
 * call would otherwise render as its own standalone bubble. This groups them.
 */
export interface ToolCallGroup {
  /** The anchor message id that hosts the combined timeline (+ handoff markers). */
  anchorId: string;
  /**
   * Ordered ids of every message in this group (anchor first, then each hoisted
   * message in message order). Used by the renderer's window-boundary fallback:
   * if the anchor is scrolled out of the visible slice, the earliest still-
   * visible member is promoted to host the timeline so it never silently
   * disappears.
   */
  memberIds: string[];
  /** Ids of the messages whose bubbles are suppressed because their calls were hoisted. */
  hoistedIds: string[];
}

export interface AnchoredToolCallGrouping<TMessage extends FlujoChatMessage = FlujoChatMessage> {
  /** For each anchor message id, its aggregated ordered non-handoff tool-call/result pairs. */
  pairsByAnchorId: Map<string, ToolCallPair<TMessage>[]>;
  /** For each anchor message id, the ordered handoff tool calls hoisted onto it. */
  handoffsByAnchorId: Map<string, OpenAI.ChatCompletionMessageToolCall[]>;
  /** Ids of assistant messages whose bubbles must be suppressed (calls hoisted, no own content). */
  hoistedAssistantIds: Set<string>;
  /** `tool_call_id`s whose standalone `role:'tool'` result bubble must be skipped. */
  consumedToolCallIds: Set<string>;
  /** One entry per anchor that actually hosts tool content, for render-window remapping. */
  groups: ToolCallGroup[];
}

/**
 * True when an assistant message carries meaningful (narration) content: a
 * non-empty/non-whitespace string, or a content-part array with a non-empty
 * text part or an image/audio part. `''`, `null`, `undefined` = not narration.
 */
export function hasMeaningfulTextContent(message: FlujoChatMessage): boolean {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some((part: unknown) => {
      if (!part || typeof part !== 'object') return false;
      const p = part as { type?: string; text?: unknown; image_url?: { url?: unknown }; input_audio?: { data?: unknown } };
      if (p.type === 'text') return typeof p.text === 'string' && p.text.trim().length > 0;
      if (p.type === 'image_url') return !!p.image_url?.url;
      if (p.type === 'input_audio') return !!p.input_audio?.data;
      return false;
    });
  }
  return false;
}

/**
 * Group every contiguous assistant run's (non-handoff) tool calls — and its
 * handoff markers — onto one anchor bubble, so the split-message shape renders
 * as a single combined timeline instead of a bubble per call.
 *
 * Anchor selection (deterministic, in message order):
 * - A `user`/`system` message ends the current run; `tool` results don't.
 * - An assistant message with meaningful text is narration: it anchors the run
 *   and keeps its own bubble. If it ALSO owns tool calls (the single-message
 *   `ModelHandler` shape) those stay on it — no regression to that path.
 * - A `content`-empty assistant message with tool calls: hoisted onto the run's
 *   current narration anchor (and its bubble suppressed). If no anchor exists
 *   yet in the run (tools-first), it becomes the anchor and hosts its own.
 *
 * Handoff tool calls are aggregated per anchor too (rendered as slim markers);
 * they are NOT added to `consumedToolCallIds` (their `{handoff:true}` result is
 * suppressed separately by the renderer, unchanged).
 */
export function groupToolCallsByAnchor<TMessage extends FlujoChatMessage>(
  messages: TMessage[]
): AnchoredToolCallGrouping<TMessage> {
  const pairsByAnchorId = new Map<string, ToolCallPair<TMessage>[]>();
  const handoffsByAnchorId = new Map<string, OpenAI.ChatCompletionMessageToolCall[]>();
  const hoistedAssistantIds = new Set<string>();
  const consumedToolCallIds = new Set<string>();
  const groupByAnchorId = new Map<string, ToolCallGroup>();
  const groups: ToolCallGroup[] = [];

  if (!Array.isArray(messages)) {
    return { pairsByAnchorId, handoffsByAnchorId, hoistedAssistantIds, consumedToolCallIds, groups };
  }

  // Index tool results by their tool_call_id (first result wins on a dup id).
  const resultByToolCallId = new Map<string, TMessage>();
  for (const message of messages) {
    if (
      message.role === 'tool' &&
      typeof message.tool_call_id === 'string' &&
      message.tool_call_id &&
      !resultByToolCallId.has(message.tool_call_id)
    ) {
      resultByToolCallId.set(message.tool_call_id, message);
    }
  }

  const ensureGroup = (anchorId: string): ToolCallGroup => {
    let group = groupByAnchorId.get(anchorId);
    if (!group) {
      group = { anchorId, memberIds: [anchorId], hoistedIds: [] };
      groupByAnchorId.set(anchorId, group);
      groups.push(group);
      pairsByAnchorId.set(anchorId, []);
      handoffsByAnchorId.set(anchorId, []);
    }
    return group;
  };

  let currentAnchorId: string | null = null;

  for (const message of messages) {
    // A user/system message ends the current contiguous assistant run.
    if (message.role === 'user' || message.role === 'system') {
      currentAnchorId = null;
      continue;
    }
    // Tool results don't break a run and are handled by pairing/consumption.
    if (message.role !== 'assistant') {
      continue;
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const pairs: ToolCallPair<TMessage>[] = [];
    const handoffCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
    for (const toolCall of toolCalls) {
      if (toolCall.type !== 'function') continue;
      if (isHandoffToolName(toolCall.function?.name)) {
        handoffCalls.push(toolCall);
        continue;
      }
      const id = toolCall.id;
      const result = id ? resultByToolCallId.get(id) : undefined;
      if (id) consumedToolCallIds.add(id);
      pairs.push({ toolCall, result });
    }

    const hasText = hasMeaningfulTextContent(message);
    const hasToolContent = pairs.length > 0 || handoffCalls.length > 0;

    if (hasText) {
      // Narration → this message anchors the run and keeps its own bubble.
      currentAnchorId = message.id;
      if (hasToolContent) {
        ensureGroup(message.id);
        pairsByAnchorId.get(message.id)!.push(...pairs);
        handoffsByAnchorId.get(message.id)!.push(...handoffCalls);
      }
      continue;
    }

    if (!hasToolContent) {
      // A truly empty assistant bubble with nothing to hoist; leave it untouched.
      continue;
    }

    if (currentAnchorId) {
      // Hoist onto the run's narration anchor and suppress this bubble.
      const group = ensureGroup(currentAnchorId);
      pairsByAnchorId.get(currentAnchorId)!.push(...pairs);
      handoffsByAnchorId.get(currentAnchorId)!.push(...handoffCalls);
      group.memberIds.push(message.id);
      group.hoistedIds.push(message.id);
      hoistedAssistantIds.add(message.id);
    } else {
      // Tools-first run (no narration yet): this message becomes the anchor and
      // hosts its own timeline; later tool-only messages hoist onto it.
      currentAnchorId = message.id;
      ensureGroup(message.id);
      pairsByAnchorId.get(message.id)!.push(...pairs);
      handoffsByAnchorId.get(message.id)!.push(...handoffCalls);
    }
  }

  return { pairsByAnchorId, handoffsByAnchorId, hoistedAssistantIds, consumedToolCallIds, groups };
}
