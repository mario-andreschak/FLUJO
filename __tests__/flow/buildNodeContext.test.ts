/**
 * execution-core-v2 context layering:
 *  - buildNodeContext shapes the node's THREADED history (written back to
 *    SharedState). It must be LOSSLESS w.r.t. non-system messages — only the
 *    system message is swapped for the node's own. (A regression here erases
 *    conversation history, e.g. a prior node's handoff turn.)
 *  - stripHandoffPlumbing is the WIRE filter (what the model sees): it removes
 *    handoff plumbing so a node handed off to sees a clean conversation, while
 *    leaving real tool pairs and agent-loop history intact.
 */
import { buildNodeContext, stripHandoffPlumbing } from '@/backend/execution/flow/buildNodeContext';
import type { FlujoChatMessage } from '@/shared/types/chat';

const sys = (content: string, id = content): FlujoChatMessage =>
  ({ role: 'system', content, id, timestamp: 1 } as FlujoChatMessage);
const user = (content: string, id = content): FlujoChatMessage =>
  ({ role: 'user', content, id, timestamp: 1 } as FlujoChatMessage);
const assistant = (content: string, id = content): FlujoChatMessage =>
  ({ role: 'assistant', content, id, timestamp: 1 } as FlujoChatMessage);
const handoffAssistant = (id: string, callId: string): FlujoChatMessage =>
  ({
    role: 'assistant',
    content: '',
    id,
    timestamp: 1,
    tool_calls: [{ id: callId, type: 'function', function: { name: 'handoff_to_nodeB', arguments: '{}' } }],
  } as FlujoChatMessage);
const toolResult = (id: string, callId: string, content = 'r'): FlujoChatMessage =>
  ({ role: 'tool', tool_call_id: callId, content, id, timestamp: 1 } as FlujoChatMessage);

describe('buildNodeContext (history — lossless except system swap)', () => {
  it('puts the node system first, drops old system, KEEPS all other messages (incl. handoff plumbing)', () => {
    const nodeSystem = sys('NODE', 'node-sys');
    const messages: FlujoChatMessage[] = [
      sys('old system', 'old-sys'),
      user('research cats', 'u1'),
      handoffAssistant('a-handoff', 'call-1'),
      toolResult('t-handoff', 'call-1', '{"status":"Handoff processed"}'),
    ];

    const out = buildNodeContext(messages, nodeSystem);

    // History must NOT lose the handoff turn/result — only the old system goes.
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a-handoff', 't-handoff']);
    expect(out.some((m) => m.id === 'old-sys')).toBe(false);
  });

  it('returns just the node system message for an empty conversation', () => {
    const nodeSystem = sys('NODE', 'node-sys');
    expect(buildNodeContext([], nodeSystem)).toEqual([nodeSystem]);
  });
});

describe('stripHandoffPlumbing (wire view — clean for the model)', () => {
  it('drops a PURE-ROUTING handoff turn (no text), its tool result, and the "Continue" nudge', () => {
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('research cats', 'u1'),
      handoffAssistant('a-handoff', 'call-1'),
      toolResult('t-handoff', 'call-1', '{"status":"Handoff processed"}'),
      user('The handoff was successful. Continue', 'cont'),
    ];

    const out = stripHandoffPlumbing(messages);

    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1']);
    expect(out[out.length - 1]).toMatchObject({ role: 'user', content: 'research cats' });
  });

  it('KEEPS the handoff turn\'s text as a plain assistant turn (the turn boundary; plan §10.1a)', () => {
    // Regression: "call 3 tools" then "call 2 more" → model did 5. The departing
    // agent's summary text is the receiving model's "previous turn is done" cue;
    // only the handoff mechanics may be stripped, never the prose.
    const handoffWithSummary: FlujoChatMessage = {
      role: 'assistant',
      content: 'I called two tools as requested: 1. echo 2. get-sum',
      id: 'a-summary',
      timestamp: 1,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'handoff_to_nodeB', arguments: '{}' } }],
    } as FlujoChatMessage;
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('call two tools', 'u1'),
      handoffWithSummary,
      toolResult('t-handoff', 'call-1', '{"status":"Handoff processed"}'),
      user('call three more', 'u2'),
    ];

    const out = stripHandoffPlumbing(messages);

    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a-summary', 'u2']);
    const kept = out.find((m) => m.id === 'a-summary')!;
    expect(kept.content).toBe('I called two tools as requested: 1. echo 2. get-sum');
    // No dangling handoff call on the wire.
    expect((kept as any).tool_calls).toBeUndefined();
    // The input message was not mutated (threaded history keeps its tool_calls).
    expect((handoffWithSummary as any).tool_calls).toHaveLength(1);
  });

  it('keeps REAL tool calls made in the same turn as a handoff (strips only the handoff call)', () => {
    const mixedTurn: FlujoChatMessage = {
      role: 'assistant',
      content: '',
      id: 'a-mixed',
      timestamp: 1,
      tool_calls: [
        { id: 'call-real', type: 'function', function: { name: 'mcp_search_abc', arguments: '{}' } },
        { id: 'call-hand', type: 'function', function: { name: 'handoff_to_nodeB', arguments: '{}' } },
      ],
    } as FlujoChatMessage;
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('q', 'u1'),
      mixedTurn,
      toolResult('t-real', 'call-real', 'results'),
      toolResult('t-hand', 'call-hand', '{"status":"Handoff processed"}'),
    ];

    const out = stripHandoffPlumbing(messages);

    // The real pair survives; the handoff call + its result vanish.
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a-mixed', 't-real']);
    const kept = out.find((m) => m.id === 'a-mixed')!;
    expect((kept as any).tool_calls).toHaveLength(1);
    expect((kept as any).tool_calls[0].id).toBe('call-real');
  });

  it('keeps real (non-handoff) tool-call/result pairs intact (agent loop safe)', () => {
    const realAssistant: FlujoChatMessage = {
      role: 'assistant',
      content: '',
      id: 'a-tool',
      timestamp: 1,
      tool_calls: [{ id: 'call-x', type: 'function', function: { name: 'mcp_search_abc', arguments: '{}' } }],
    } as FlujoChatMessage;
    const messages = [sys('NODE', 'node-sys'), user('q', 'u1'), realAssistant, toolResult('t-tool', 'call-x', 'results')];

    const out = stripHandoffPlumbing(messages);

    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a-tool', 't-tool']);
  });

  it('leaves a plain conversation untouched', () => {
    const messages = [sys('NODE', 'node-sys'), user('hi', 'u1'), assistant('hello', 'a1'), user('more', 'u2')];
    expect(stripHandoffPlumbing(messages).map((m) => m.id)).toEqual(['node-sys', 'u1', 'a1', 'u2']);
  });
});
