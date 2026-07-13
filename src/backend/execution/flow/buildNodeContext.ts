import OpenAI from 'openai';
import { FlujoChatMessage } from '@/shared/types/chat';

/** True when this assistant turn is mid-action (made tool calls). */
function isToolCallTurn(
  m: FlujoChatMessage
): m is FlujoChatMessage & { role: 'assistant'; tool_calls: OpenAI.ChatCompletionMessageToolCall[] } {
  return m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

/**
 * The trailing agentic exchange for the CURRENT turn, if the conversation ends
 * in one. A node's tool loop appends `assistant(tool_calls)` then `tool` results
 * and re-enters until the model emits a plain assistant turn (which ends the
 * loop). So while a tool loop is in progress, the tail is a contiguous suffix of
 * `assistant(tool_calls)` / `tool` messages with no plain-final assistant among
 * them. Walk back from the end collecting those; stop at the first user/system
 * message or plain (final) assistant turn. Returns [] when the conversation is
 * settled (does not end in an unresolved tool exchange).
 */
function currentToolTail(messages: FlujoChatMessage[]): FlujoChatMessage[] {
  let i = messages.length - 1;
  for (; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool' || isToolCallTurn(m)) continue;
    break;
  }
  const tail = messages.slice(i + 1);
  // A bare tail with no tool-call turn (e.g. a stray trailing tool message) is
  // not a real in-flight exchange — don't resurrect it.
  return tail.some(isToolCallTurn) ? tail : [];
}

/**
 * Narrow a node's assembled context (a leading system message + threaded
 * history, as produced by buildNodeContext) to just what the MODEL should see
 * for the given inputMode. This shapes only the WIRE view — the caller keeps the
 * full history for persistence — so it must be safe to recompute every tool-loop
 * iteration:
 *   - 'full-history' (default): unchanged.
 *   - 'latest-message': the leading system message(s), then everything from the
 *     most recent user message onward (which includes any in-flight tool
 *     exchange for the current turn). Falls back to the full list when there is
 *     no user message.
 *   - 'isolated': the leading system message(s), then `isolatedPrompt` as a
 *     single synthetic user message, then the current in-flight tool tail (so a
 *     tool-using isolated node can continue its loop across re-entries). The
 *     prior conversation is dropped. The synthetic user message is wire-only.
 */
export function scopeMessagesForInput(
  messages: FlujoChatMessage[],
  inputMode: 'full-history' | 'latest-message' | 'isolated' | undefined,
  isolatedPrompt?: string,
): FlujoChatMessage[] {
  if (!inputMode || inputMode === 'full-history') return messages;

  const system = messages.filter((m) => m.role === 'system');

  if (inputMode === 'isolated') {
    const userMsg: FlujoChatMessage = {
      role: 'user',
      content: isolatedPrompt ?? '',
      // Wire-only: id/timestamp are stripped by toApiMessages, but keep the
      // shape valid.
      id: 'isolated-input',
      timestamp: 0,
    };
    return [...system, userMsg, ...currentToolTail(messages)];
  }

  // 'latest-message'
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return messages; // no user turn — keep everything
  return [...system, ...messages.slice(lastUserIdx)];
}

/** True when this tool-call turn contains a FLUJO handoff call — i.e. it is a
 *  node's TERMINAL routing turn (a plain turn would have ended the loop instead). */
function hasHandoffCall(
  m: FlujoChatMessage & { tool_calls: OpenAI.ChatCompletionMessageToolCall[] }
): boolean {
  return m.tool_calls.some((tc) => tc.type === 'function' && isHandoffToolName(tc.function.name));
}

/**
 * Collapse the SETTLED internal turns of nodes whose outputMode is
 * 'latest-message' (the output-side counterpart of scopeMessagesForInput):
 * their assistant(tool_calls) turns and the matching tool results are removed
 * from the wire view, leaving only their text responses. This is what lets a
 * tool-heavy step stop re-sending its whole tool exchange to every later
 * model call.
 *
 * Rules, in the same spirit as stripHandoffPlumbing:
 *   - WIRE view only — callers must keep the full history for persistence.
 *   - The current in-flight tool exchange (the unresolved trailing tail) is
 *     NEVER touched, so the node that is looping right now can continue even
 *     when it itself is collapsed.
 *   - Tool results are dropped by tool_call_id of a dropped call turn — never
 *     by processNodeId alone — so a legacy call turn without a processNodeId
 *     can't be left dangling.
 *   - A node that ends a visit by HANDOFF never emits a plain assistant turn
 *     (a plain turn would end its loop without handing off), so its final
 *     response is the prose ON the handoff turn. That prose survives as a
 *     text-only assistant turn — mirroring stripHandoffPlumbing, which treats
 *     the departing agent's summary as the receiving model's turn boundary.
 *   - OUTPUT GUARANTEE: a visit is collapsed only when some text of it
 *     survives (a plain assistant turn, or handoff prose). A visit that only
 *     made tool calls and handed off with no text keeps its tool exchange —
 *     collapsing it would erase the node's entire contribution and later
 *     steps would see nothing of its work.
 *   - A mid-loop assistant turn that mixes prose with REAL tool calls is
 *     still dropped whole (mid-action narration, not the final response;
 *     same treatment as sanitizeForSubflow).
 * Returns the input array unchanged (same reference) when nothing collapses.
 */
export function collapseNodeOutputs(
  messages: FlujoChatMessage[],
  collapsedNodeIds: ReadonlySet<string>,
): FlujoChatMessage[] {
  if (collapsedNodeIds.size === 0) return messages;

  const settledEnd = messages.length - currentToolTail(messages).length;

  // Segment the settled region into node "visits" — contiguous runs of
  // messages stamped with the same processNodeId (ModelHandler stamps every
  // agent-loop message) — and mark, per message, whether its visit keeps any
  // text after collapsing. Per-VISIT, not per-node: in a recurring chat flow
  // the same node runs once per user turn, and a later visit that produced no
  // text must be preserved even when an earlier visit did produce text.
  const visitKeepsText = new Array<boolean>(settledEnd).fill(false);
  for (let start = 0; start < settledEnd; ) {
    const nodeId = messages[start].processNodeId;
    let end = start;
    while (end < settledEnd && messages[end].processNodeId === nodeId) end++;
    let keepsText = false;
    if (nodeId) {
      for (let i = start; i < end; i++) {
        const m = messages[i];
        if (m.role !== 'assistant' || !hasTextContent(m)) continue;
        if (!isToolCallTurn(m) || hasHandoffCall(m)) {
          keepsText = true;
          break;
        }
      }
    }
    for (let i = start; i < end; i++) visitKeepsText[i] = keepsText;
    start = end;
  }

  const droppedCallIds = new Set<string>();
  const out: FlujoChatMessage[] = [];
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (i < settledEnd) {
      if (
        isToolCallTurn(m) &&
        m.processNodeId &&
        collapsedNodeIds.has(m.processNodeId) &&
        visitKeepsText[i]
      ) {
        for (const tc of m.tool_calls) droppedCallIds.add(tc.id);
        changed = true;
        if (hasHandoffCall(m) && hasTextContent(m)) {
          // Terminal handoff turn with prose: keep the node's final response
          // as a plain assistant turn. Its call ids were dropped above, so
          // the matching tool results go with them and nothing dangles.
          const { tool_calls: _droppedCalls, ...rest } = m;
          out.push(rest as FlujoChatMessage);
        }
        continue;
      }
      if (m.role === 'tool' && m.tool_call_id && droppedCallIds.has(m.tool_call_id)) {
        changed = true;
        continue;
      }
    }
    out.push(m);
  }
  return changed ? out : messages;
}

// The synthetic user message the run loop used to append after a handoff to
// un-stall the receiving model. No longer produced; also stripped from the wire
// defensively (old conversations may still contain it).
const HANDOFF_CONTINUE_MESSAGE = 'The handoff was successful. Continue';

function isHandoffToolName(name: string): boolean {
  return name === 'handoff' || name.startsWith('handoff_to_');
}

/**
 * Assemble a node's conversation history: drop any pre-existing system messages,
 * put the node's own system prompt first, keep every other message in order.
 *
 * This is the chokepoint for what becomes the node's threaded history (it is
 * written back to SharedState.messages by ProcessNode). It MUST be lossless
 * w.r.t. non-system messages — scoping what the *model* sees is a separate
 * concern handled at the provider boundary by stripHandoffPlumbing (see below),
 * so persisted history is never destroyed. See ~/.claude/plans/execution-core-v2.md.
 */
export function buildNodeContext(
  messages: FlujoChatMessage[],
  systemMessage: FlujoChatMessage,
): FlujoChatMessage[] {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  return [systemMessage, ...nonSystem];
}

// Does this message carry any renderable text? (assistant content is a string
// in FLUJO; array-of-parts is handled defensively for OpenAI-shaped imports)
function hasTextContent(m: FlujoChatMessage): boolean {
  if (typeof m.content === 'string') return m.content.trim().length > 0;
  if (Array.isArray(m.content)) return (m.content as unknown[]).length > 0;
  return false;
}

/**
 * Filter applied to the messages sent **to the model** (the wire view), NOT to
 * the threaded history. Removes FLUJO handoff *mechanics* so a node that was
 * handed off to sees a clean conversation ending on the real task instead of a
 * dangling `handoff_to_*` tool-call and a synthetic "Continue":
 *   - handoff tool calls are removed from their assistant turn — but the turn's
 *     TEXT is kept: the departing agent's own summary/answer is the receiving
 *     model's "previous turn is done" boundary, and dropping it makes models
 *     re-count earlier work (see plan §10.1a). The turn is dropped entirely
 *     only when it is pure routing (no text, no other tool calls),
 *   - each handoff call's tool result (matched by tool_call_id),
 *   - the synthetic "Continue" user message.
 *
 * Real (MCP) tool-call/result pairs and a node's own agent-loop history are
 * preserved — including real calls made in the same turn as a handoff.
 * System messages pass through. Never mutates the input messages.
 */
export function stripHandoffPlumbing(messages: FlujoChatMessage[]): FlujoChatMessage[] {
  const handoffToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.type === 'function' && isHandoffToolName(tc.function.name)) {
          handoffToolCallIds.add(tc.id);
        }
      }
    }
  }

  const out: FlujoChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim() === HANDOFF_CONTINUE_MESSAGE) {
      continue;
    }
    if (m.role === 'tool' && m.tool_call_id && handoffToolCallIds.has(m.tool_call_id)) {
      continue;
    }
    if (
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => tc.type === 'function' && isHandoffToolName(tc.function.name))
    ) {
      const realToolCalls = m.tool_calls.filter(
        (tc) => !(tc.type === 'function' && isHandoffToolName(tc.function.name)),
      );
      if (realToolCalls.length > 0) {
        out.push({ ...m, tool_calls: realToolCalls });
      } else if (hasTextContent(m)) {
        // Keep the agent's prose as a plain assistant turn (the turn boundary);
        // omit tool_calls entirely so no provider sees a dangling call.
        const { tool_calls: _dropped, ...rest } = m;
        out.push(rest as FlujoChatMessage);
      }
      // else: pure routing turn (no text, no real calls) — drop it.
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Convert FLUJO's threaded messages into clean OpenAI-spec wire messages:
 * stripHandoffPlumbing (see above) plus removal of every FLUJO-internal
 * bookkeeping field (id, timestamp, disabled, processNodeId, depth, usage).
 *
 * Only `timestamp` used to be stripped here, so the internal fields went to
 * providers on every request. Most OpenAI-compatible endpoints ignore unknown
 * message fields, but strict backends (e.g. some upstreams behind router
 * services like Requesty) reject the whole request with a generic
 * "400 Bad Request". The wire payload must contain only what the OpenAI chat
 * spec defines.
 */
export function toApiMessages(messages: FlujoChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return stripHandoffPlumbing(messages).map(
    ({ id, timestamp, disabled, processNodeId, depth, usage, ...rest }) =>
      rest as OpenAI.ChatCompletionMessageParam
  );
}
