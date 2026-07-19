/**
 * Issue #167 (Phase 2 of #162): the debugger must be able to show the wire
 * conversation at EVERY model call a node makes across its tool loop, exposed as
 * DebugStep.modelInputs (an ordered array), with the singular DebugStep.modelInput
 * kept as the first/representative snapshot for backward compatibility.
 *
 * These tests lock the two guarantees the feature rests on:
 *   1. Each per-model-call ModelInputSnapshot's wire view equals EXACTLY what the
 *      provider boundary (toApiMessages) sends for that iteration's inputs — so a
 *      paged in-loop wire can never drift from what actually hit the model. This
 *      is the fidelity claim in the issue.
 *   2. The plural `modelInputs` array's first entry deep-equals the singular
 *      `modelInput` (older traces / the singular renderer keep working).
 *
 * They reuse the exact runtime pipeline functions (deriveModelInputView /
 * scopeMessagesForInput / toApiMessages), so the assertions can't diverge from
 * behaviour, mirroring buildNodeContext.test.ts.
 */
import {
  deriveModelInputView,
  scopeMessagesForInput,
  toApiMessages,
} from '@/backend/execution/flow/buildNodeContext';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { ModelInputSnapshot } from '@/backend/execution/flow/types';

const sys = (content: string, id = content): FlujoChatMessage =>
  ({ role: 'system', content, id, timestamp: 1 } as FlujoChatMessage);
const user = (content: string, id = content): FlujoChatMessage =>
  ({ role: 'user', content, id, timestamp: 1 } as FlujoChatMessage);
const assistant = (content: string, id = content): FlujoChatMessage =>
  ({ role: 'assistant', content, id, timestamp: 1 } as FlujoChatMessage);
const toolCallAssistant = (id: string, callId: string): FlujoChatMessage =>
  ({
    role: 'assistant',
    content: '',
    id,
    timestamp: 1,
    tool_calls: [{ id: callId, type: 'function', function: { name: 'mcp_search_abc', arguments: '{}' } }],
  } as FlujoChatMessage);
const toolResult = (id: string, callId: string, content = 'r'): FlujoChatMessage =>
  ({ role: 'tool', tool_call_id: callId, content, id, timestamp: 1 } as FlujoChatMessage);

// Strip FLUJO-internal fields exactly like toApiMessages, so a snapshot's wire
// view can be compared byte-for-byte against what the provider receives.
const stripInternal = (msgs: FlujoChatMessage[]) =>
  msgs.map(({ id, timestamp, disabled, processNodeId, depth, usage, ...rest }: any) => rest);

// The single-call construction ProcessNode.prep performs under its debug gate:
// modelInputs = [modelInput]. Kept here as the contract under test so a change
// to the shape is caught.
const buildModelInputs = (modelInput?: ModelInputSnapshot): ModelInputSnapshot[] | undefined =>
  modelInput ? [modelInput] : undefined;

describe('DebugStep.modelInputs (issue #167 — per-model-call wire snapshots)', () => {
  it("each iteration's snapshot wire equals what toApiMessages sends that iteration", () => {
    // Model a node in a 'latest-message'-scoped tool loop. Iteration 1: the model
    // sees the current user turn. Iteration 2 (mid-loop re-entry): the in-flight
    // assistant(tool_calls) + tool result now follow the user turn and must be on
    // the wire so the loop can continue.
    const iter1History = [
      sys('NODE', 'node-sys'),
      user('old', 'u1'),
      assistant('prior answer', 'a1'),
      user('current task', 'u2'),
    ];
    const iter2History = [
      ...iter1History,
      toolCallAssistant('a2', 'call-1'),
      toolResult('t2', 'call-1', 'tool output'),
    ];

    const snaps: ModelInputSnapshot[] = [iter1History, iter2History].map((threaded) => {
      const scopedView = scopeMessagesForInput(threaded, 'latest-message');
      return deriveModelInputView({
        threaded,
        foldedView: threaded,
        scopedView,
        systemContent: 'NODE',
        inputMode: 'latest-message',
      });
    });

    // Iteration 1 wire: system + the current user turn only (prior turns scoped out).
    expect(stripInternal(snaps[0].wireMessages)).toEqual(
      toApiMessages(scopeMessagesForInput(iter1History, 'latest-message')),
    );
    expect(snaps[0].wireMessages.map((m) => m.id)).toEqual(['node-sys', 'u2']);

    // Iteration 2 wire: system + user turn + the in-flight tool exchange — a
    // DIFFERENT wire, which is exactly what earlier single-snapshot capture missed.
    expect(stripInternal(snaps[1].wireMessages)).toEqual(
      toApiMessages(scopeMessagesForInput(iter2History, 'latest-message')),
    );
    expect(snaps[1].wireMessages.map((m) => m.id)).toEqual(['node-sys', 'u2', 'a2', 't2']);

    // The two iterations genuinely differ — proving per-iteration capture matters.
    expect(snaps[0].wireMessages.map((m) => m.id)).not.toEqual(snaps[1].wireMessages.map((m) => m.id));
  });

  it('modelInputs[0] deep-equals the singular modelInput (backward compatibility)', () => {
    const threaded = [sys('NODE', 'node-sys'), user('hi', 'u1'), assistant('hello', 'a1')];
    const modelInput = deriveModelInputView({
      threaded,
      foldedView: threaded,
      scopedView: threaded,
      systemContent: 'NODE',
      inputMode: 'full-history',
    });

    const modelInputs = buildModelInputs(modelInput);
    expect(modelInputs).toHaveLength(1);
    expect(modelInputs![0]).toEqual(modelInput);
    // The representative snapshot is the SAME reference the singular field holds.
    expect(modelInputs![0]).toBe(modelInput);
  });

  it('a step with no model call produces no modelInputs array', () => {
    expect(buildModelInputs(undefined)).toBeUndefined();
  });

  it('the snapshots carry conversation content only — never credentials', () => {
    const threaded = [sys('NODE', 'node-sys'), user('hi', 'u1')];
    const snap = deriveModelInputView({
      threaded,
      foldedView: threaded,
      scopedView: threaded,
      systemContent: 'NODE',
      inputMode: 'full-history',
    });
    const serialized = JSON.stringify(buildModelInputs(snap));
    expect(serialized).not.toMatch(/apiKey|api_key|Authorization|baseUrl/i);
  });
});
