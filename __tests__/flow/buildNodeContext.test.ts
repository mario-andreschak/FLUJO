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
