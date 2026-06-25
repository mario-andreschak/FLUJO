/**
 * Phase 1 of execution-core-v2: buildNodeContext is the single chokepoint for
 * what a node's LLM sees. This phase is a behavior-preserving extraction of the
 * logic that lived inline in ProcessNode.prep, so these tests pin the legacy
 * ('full') behavior that must NOT change until Phase 2 deliberately does:
 *   - the node's own system message goes first,
 *   - any pre-existing system messages are dropped,
 *   - all other messages keep their order.
 */
import { buildNodeContext } from '@/backend/execution/flow/buildNodeContext';
import type { FlujoChatMessage } from '@/shared/types/chat';

const sys = (content: string, id = content): FlujoChatMessage =>
  ({ role: 'system', content, id, timestamp: 1 } as FlujoChatMessage);
const user = (content: string, id = content): FlujoChatMessage =>
  ({ role: 'user', content, id, timestamp: 1 } as FlujoChatMessage);
const assistant = (content: string, id = content): FlujoChatMessage =>
  ({ role: 'assistant', content, id, timestamp: 1 } as FlujoChatMessage);

describe('buildNodeContext (Phase 1 — full policy, behavior-preserving)', () => {
  it('puts the node system message first and drops pre-existing system messages', () => {
    const nodeSystem = sys('NODE PROMPT', 'node-sys');
    const messages: FlujoChatMessage[] = [
      sys('old system', 'old-sys'),
      user('hello', 'u1'),
      assistant('hi there', 'a1'),
    ];

    const out = buildNodeContext(messages, nodeSystem);

    expect(out[0]).toBe(nodeSystem);
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a1']);
    expect(out.some((m) => m.id === 'old-sys')).toBe(false);
  });

  it('preserves the order of non-system messages', () => {
    const nodeSystem = sys('NODE', 'node-sys');
    const messages = [user('1', 'u1'), assistant('2', 'a1'), user('3', 'u2')];

    const out = buildNodeContext(messages, nodeSystem);

    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a1', 'u2']);
  });

  it('returns just the node system message for an empty conversation', () => {
    const nodeSystem = sys('NODE', 'node-sys');
    expect(buildNodeContext([], nodeSystem)).toEqual([nodeSystem]);
  });
});

describe('buildNodeContext (Phase 2 — scoped policy strips handoff plumbing)', () => {
  const handoffAssistant = (id: string, callId: string): FlujoChatMessage =>
    ({
      role: 'assistant',
      content: "I'll route this",
      id,
      timestamp: 1,
      tool_calls: [{ id: callId, type: 'function', function: { name: 'handoff_to_nodeB', arguments: '{}' } }],
    } as FlujoChatMessage);
  const handoffResult = (id: string, callId: string): FlujoChatMessage =>
    ({ role: 'tool', tool_call_id: callId, content: '{"status":"Handoff processed"}', id, timestamp: 1 } as FlujoChatMessage);
  const continueMsg = (): FlujoChatMessage =>
    ({ role: 'user', content: 'The handoff was successful. Continue', id: 'cont', timestamp: 1 } as FlujoChatMessage);

  it('drops the handoff turn, its tool result, and the "Continue" nudge — ending on the real task', () => {
    const nodeSystem = sys('NODE B', 'node-sys');
    const messages: FlujoChatMessage[] = [
      sys('start system', 'old-sys'),
      user('I want to research about cats', 'u1'),
      handoffAssistant('a-handoff', 'call-1'),
      handoffResult('t-handoff', 'call-1'),
      continueMsg(),
    ];

    const out = buildNodeContext(messages, nodeSystem, 'scoped');

    // Only the node's system prompt and the real user task survive.
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1']);
    expect(out[out.length - 1]).toMatchObject({ role: 'user', content: 'I want to research about cats' });
  });

  it('keeps real (non-handoff) tool-call/result pairs intact (agent loop safe)', () => {
    const nodeSystem = sys('NODE', 'node-sys');
    const realAssistant: FlujoChatMessage = {
      role: 'assistant',
      content: '',
      id: 'a-tool',
      timestamp: 1,
      tool_calls: [{ id: 'call-x', type: 'function', function: { name: 'mcp_search_abc', arguments: '{}' } }],
    } as FlujoChatMessage;
    const realResult: FlujoChatMessage = { role: 'tool', tool_call_id: 'call-x', content: 'results', id: 't-tool', timestamp: 1 } as FlujoChatMessage;
    const messages = [user('q', 'u1'), realAssistant, realResult];

    const out = buildNodeContext(messages, nodeSystem, 'scoped');

    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a-tool', 't-tool']);
  });
});
