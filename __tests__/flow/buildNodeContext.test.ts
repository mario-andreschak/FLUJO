/**
 * execution-core-v2 context layering:
 *  - buildNodeContext shapes the node's THREADED history (written back to
 *    SharedState). It must be LOSSLESS w.r.t. non-system messages — only the
 *    system message is swapped for the node's own. (A regression here erases
 *    conversation history, e.g. a prior node's handoff turn.)
 *  - stripHandoffPlumbing is the WIRE filter (what the model sees): it removes
 *    handoff plumbing so a node handed off to sees a clean conversation, while
 *    leaving real tool pairs and agent-loop history intact.
 *  - toApiMessages is the full provider-boundary mapping: stripHandoffPlumbing
 *    plus removal of every FLUJO-internal field. Strict OpenAI-compatible
 *    backends reject requests whose messages carry unknown fields with a
 *    generic "400 Bad Request" (seen via Requesty), so nothing beyond the
 *    OpenAI spec may survive this mapping.
 */
import { buildNodeContext, stripHandoffPlumbing, toApiMessages, scopeMessagesForInput, collapseNodeOutputs, deriveModelInputView } from '@/backend/execution/flow/buildNodeContext';
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
const toolCallAssistant = (id: string, callId: string): FlujoChatMessage =>
  ({
    role: 'assistant',
    content: '',
    id,
    timestamp: 1,
    tool_calls: [{ id: callId, type: 'function', function: { name: 'mcp_search_abc', arguments: '{}' } }],
  } as FlujoChatMessage);

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

describe('scopeMessagesForInput (process node inputMode — WIRE view only)', () => {
  it("'full-history' (and undefined) returns the messages unchanged", () => {
    const messages = [sys('NODE', 'node-sys'), user('a', 'u1'), assistant('b', 'a1'), user('c', 'u2')];
    expect(scopeMessagesForInput(messages, 'full-history')).toBe(messages);
    expect(scopeMessagesForInput(messages, undefined)).toBe(messages);
  });

  it("'latest-message' keeps the system message plus everything from the last user message on", () => {
    const messages = [sys('NODE', 'node-sys'), user('old', 'u1'), assistant('done', 'a1'), user('current', 'u2')];
    const out = scopeMessagesForInput(messages, 'latest-message');
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u2']);
  });

  it("'latest-message' includes the in-flight tool exchange that follows the last user message", () => {
    // Mid tool-loop re-entry: the assistant tool call + its result come after the
    // current user turn and must survive so the model can continue the loop.
    const messages = [
      sys('NODE', 'node-sys'),
      user('old', 'u1'),
      assistant('done', 'a1'),
      user('current', 'u2'),
      toolCallAssistant('a2', 'call-1'),
      toolResult('t2', 'call-1'),
    ];
    const out = scopeMessagesForInput(messages, 'latest-message');
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u2', 'a2', 't2']);
  });

  it("'latest-message' falls back to the full list when there is no user message", () => {
    const messages = [sys('NODE', 'node-sys'), assistant('b', 'a1')];
    expect(scopeMessagesForInput(messages, 'latest-message')).toBe(messages);
  });

  it("'isolated' drops the conversation and sends the isolated prompt as the user message", () => {
    const messages = [sys('NODE', 'node-sys'), user('old', 'u1'), assistant('done', 'a1')];
    const out = scopeMessagesForInput(messages, 'isolated', 'do the thing');
    expect(out.map((m) => m.role)).toEqual(['system', 'user']);
    expect(out[0].content).toBe('NODE');
    expect(out[1]).toMatchObject({ role: 'user', content: 'do the thing' });
  });

  it("'isolated' keeps the current in-flight tool tail so a tool-using isolated node can loop", () => {
    // On re-entry the history is [prior settled turns, assistant(tool_calls), tool].
    // The isolated prompt is re-seeded and the unresolved tail preserved.
    const messages = [
      sys('NODE', 'node-sys'),
      user('old', 'u1'),
      assistant('settled', 'a1'),
      toolCallAssistant('a2', 'call-1'),
      toolResult('t2', 'call-1'),
    ];
    const out = scopeMessagesForInput(messages, 'isolated', 'task');
    expect(out.map((m) => m.id ?? m.role)).toEqual(['node-sys', 'isolated-input', 'a2', 't2']);
    expect(out[1]).toMatchObject({ role: 'user', content: 'task' });
  });

  it("'isolated' with a settled conversation has no tail (just system + isolated user)", () => {
    const messages = [
      sys('NODE', 'node-sys'),
      user('old', 'u1'),
      toolCallAssistant('a1', 'call-1'),
      toolResult('t1', 'call-1'),
      assistant('final answer', 'a2'), // loop ended → settled
    ];
    const out = scopeMessagesForInput(messages, 'isolated', 'task');
    expect(out.map((m) => m.role)).toEqual(['system', 'user']);
    expect(out[1].content).toBe('task');
  });

  it("'isolated' tolerates a missing prompt (empty user message)", () => {
    const messages = [sys('NODE', 'node-sys'), user('old', 'u1')];
    const out = scopeMessagesForInput(messages, 'isolated');
    expect(out[1]).toMatchObject({ role: 'user', content: '' });
  });
});

describe("collapseNodeOutputs (process node outputMode 'latest-message' — WIRE view only)", () => {
  const fromNode = (m: FlujoChatMessage, nodeId: string): FlujoChatMessage =>
    ({ ...m, processNodeId: nodeId } as FlujoChatMessage);

  it("collapses a settled node's tool exchange but keeps its final response", () => {
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('research cats', 'u1'),
      fromNode(toolCallAssistant('a1', 'call-1'), 'node-A'),
      fromNode(toolResult('t1', 'call-1', 'big tool payload'), 'node-A'),
      fromNode(assistant('final summary', 'a2'), 'node-A'), // settled → collapse applies
      user('next task', 'u2'),
    ];
    const out = collapseNodeOutputs(messages, new Set(['node-A']));
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a2', 'u2']);
  });

  it('only collapses the listed nodes — other nodes keep their tool pairs', () => {
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('q', 'u1'),
      fromNode(toolCallAssistant('a1', 'call-1'), 'node-A'),
      fromNode(toolResult('t1', 'call-1'), 'node-A'),
      fromNode(assistant('A done', 'a2'), 'node-A'),
      fromNode(toolCallAssistant('b1', 'call-2'), 'node-B'),
      fromNode(toolResult('t2', 'call-2'), 'node-B'),
      fromNode(assistant('B done', 'b2'), 'node-B'),
    ];
    const out = collapseNodeOutputs(messages, new Set(['node-A']));
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a2', 'b1', 't2', 'b2']);
  });

  it('NEVER touches the current in-flight tool exchange (the collapsed node can keep looping)', () => {
    // node-A is mid tool-loop: its earlier settled exchange collapses, the
    // unresolved trailing exchange must survive for the loop to continue.
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('q', 'u1'),
      fromNode(toolCallAssistant('a1', 'call-1'), 'node-A'),
      fromNode(toolResult('t1', 'call-1'), 'node-A'),
      fromNode(assistant('first answer', 'a2'), 'node-A'), // settles the first exchange
      fromNode(toolCallAssistant('a3', 'call-2'), 'node-A'),
      fromNode(toolResult('t3', 'call-2'), 'node-A'), // in-flight tail
    ];
    const out = collapseNodeOutputs(messages, new Set(['node-A']));
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a2', 'a3', 't3']);
  });

  it('drops tool results only when their call turn was dropped (no dangling pairs from legacy messages)', () => {
    // A legacy call turn WITHOUT a processNodeId cannot be attributed → it stays,
    // and so must its result, even though the result carries the collapsed node id.
    const legacyCall = toolCallAssistant('a1', 'call-1'); // no processNodeId
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('q', 'u1'),
      legacyCall,
      fromNode(toolResult('t1', 'call-1'), 'node-A'),
      fromNode(assistant('done', 'a2'), 'node-A'),
    ];
    const out = collapseNodeOutputs(messages, new Set(['node-A']));
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a1', 't1', 'a2']);
  });

  it('returns the SAME array when there is nothing to collapse', () => {
    const messages = [sys('NODE', 'node-sys'), user('q', 'u1'), fromNode(assistant('done', 'a1'), 'node-A')];
    expect(collapseNodeOutputs(messages, new Set(['node-A']))).toBe(messages);
    expect(collapseNodeOutputs(messages, new Set())).toBe(messages);
  });

  // A node that hands off never emits a plain assistant turn (a plain turn
  // would end its loop WITHOUT handing off) — its final response is the prose
  // on the handoff turn, and a collapsed node must not lose it.
  it("keeps the prose of a settled handoff turn as the node's final response", () => {
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('research cats', 'u1'),
      fromNode(toolCallAssistant('a1', 'call-1'), 'node-A'),
      fromNode(toolResult('t1', 'call-1', 'big tool payload'), 'node-A'),
      fromNode({ ...handoffAssistant('a2', 'call-2'), content: 'Research summary: cats are neat.' } as FlujoChatMessage, 'node-A'),
      fromNode(toolResult('t2', 'call-2', '{"status":"Handoff processed"}'), 'node-A'),
      fromNode(assistant('B is working', 'b1'), 'node-B'), // settles A's exchange
    ];
    const out = collapseNodeOutputs(messages, new Set(['node-A']));
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a2', 'b1']);
    const kept = out.find((m) => m.id === 'a2')!;
    expect(kept.content).toBe('Research summary: cats are neat.');
    expect((kept as { tool_calls?: unknown }).tool_calls).toBeUndefined();
  });

  it('does NOT collapse a visit that produced no text at all (only tool calls + a textless handoff)', () => {
    // Erasing it would remove the node's entire contribution from the wire —
    // later steps would see nothing of its work.
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('research cats', 'u1'),
      fromNode(toolCallAssistant('a1', 'call-1'), 'node-A'),
      fromNode(toolResult('t1', 'call-1', 'the only trace of the work'), 'node-A'),
      fromNode(handoffAssistant('a2', 'call-2'), 'node-A'), // no prose
      fromNode(toolResult('t2', 'call-2', '{"status":"Handoff processed"}'), 'node-A'),
      fromNode(assistant('B is working', 'b1'), 'node-B'),
    ];
    expect(collapseNodeOutputs(messages, new Set(['node-A']))).toBe(messages);
  });

  it("collapses per VISIT — an earlier visit's text does not license erasing a later textless visit", () => {
    // Recurring chat flow: node-A runs once per user turn. Turn 1 produced a
    // plain answer (collapses); turn 2 only made tool calls and a textless
    // handoff (must be preserved).
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('turn one', 'u1'),
      fromNode(toolCallAssistant('a1', 'call-1'), 'node-A'),
      fromNode(toolResult('t1', 'call-1'), 'node-A'),
      fromNode(assistant('first answer', 'a2'), 'node-A'),
      user('turn two', 'u2'),
      fromNode(toolCallAssistant('a3', 'call-2'), 'node-A'),
      fromNode(toolResult('t3', 'call-2'), 'node-A'),
      fromNode(handoffAssistant('a4', 'call-3'), 'node-A'), // textless terminal turn
      fromNode(toolResult('t4', 'call-3', '{"status":"Handoff processed"}'), 'node-A'),
      fromNode(assistant('B is working', 'b1'), 'node-B'),
    ];
    const out = collapseNodeOutputs(messages, new Set(['node-A']));
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a2', 'u2', 'a3', 't3', 'a4', 't4', 'b1']);
  });

  it('still drops a mid-loop turn that mixes prose with REAL tool calls (narration, not the final response)', () => {
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('q', 'u1'),
      fromNode({ ...toolCallAssistant('a1', 'call-1'), content: 'Let me search for that…' } as FlujoChatMessage, 'node-A'),
      fromNode(toolResult('t1', 'call-1'), 'node-A'),
      fromNode(assistant('the real answer', 'a2'), 'node-A'),
    ];
    const out = collapseNodeOutputs(messages, new Set(['node-A']));
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a2']);
  });

  it('composes with scopeMessagesForInput (collapse first, then input scoping)', () => {
    // A single-user-turn run: 'latest-message' inputMode alone keeps everything
    // after u1, so the collapse is what actually removes node-A's tool spam.
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('the task', 'u1'),
      fromNode(toolCallAssistant('a1', 'call-1'), 'node-A'),
      fromNode(toolResult('t1', 'call-1'), 'node-A'),
      fromNode(assistant('A final', 'a2'), 'node-A'),
    ];
    const out = scopeMessagesForInput(collapseNodeOutputs(messages, new Set(['node-A'])), 'latest-message');
    expect(out.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a2']);
  });
});

describe('toApiMessages (provider boundary — OpenAI-spec fields only)', () => {
  it('strips every FLUJO-internal field (id, timestamp, disabled, processNodeId, depth, usage)', () => {
    // Mirrors what a real threaded history carries after an agentic run:
    // ModelHandler attaches usage/processNodeId to assistant turns, every
    // message has id/timestamp.
    const assistantWithBookkeeping: FlujoChatMessage = {
      role: 'assistant',
      content: 'summary',
      id: 'a1',
      timestamp: 1,
      processNodeId: 'node-1',
      depth: 0,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      tool_calls: [{ id: 'call-x', type: 'function', function: { name: 'mcp_search_abc', arguments: '{}' } }],
    } as FlujoChatMessage;
    const toolWithBookkeeping: FlujoChatMessage = {
      role: 'tool',
      tool_call_id: 'call-x',
      content: 'results',
      id: 't1',
      timestamp: 2,
      processNodeId: 'node-1',
      disabled: false,
    } as FlujoChatMessage;
    const messages = [sys('NODE', 'node-sys'), user('q', 'u1'), assistantWithBookkeeping, toolWithBookkeeping];

    const out = toApiMessages(messages);

    // Exactly the OpenAI-spec fields survive — nothing internal.
    expect(out).toEqual([
      { role: 'system', content: 'NODE' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'summary',
        tool_calls: [{ id: 'call-x', type: 'function', function: { name: 'mcp_search_abc', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-x', content: 'results' },
    ]);
  });

  it('composes with stripHandoffPlumbing (handoff mechanics gone AND fields clean)', () => {
    const messages: FlujoChatMessage[] = [
      sys('NODE', 'node-sys'),
      user('q', 'u1'),
      handoffAssistant('a-handoff', 'call-1'),
      toolResult('t-handoff', 'call-1', '{"status":"Handoff processed"}'),
    ];

    const out = toApiMessages(messages);

    expect(out).toEqual([
      { role: 'system', content: 'NODE' },
      { role: 'user', content: 'q' },
    ]);
  });

  it('does not mutate the threaded history', () => {
    const m: FlujoChatMessage = {
      role: 'assistant',
      content: 'x',
      id: 'a1',
      timestamp: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } as FlujoChatMessage;

    toApiMessages([m]);

    expect(m.id).toBe('a1');
    expect(m.usage).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
  });
});

describe('deriveModelInputView (debugger model-input explanation — issue #153)', () => {
  // Strip FLUJO-internal fields exactly like toApiMessages, so a snapshot's
  // wire view can be compared byte-for-byte against what the provider receives.
  const stripInternal = (msgs: FlujoChatMessage[]) =>
    msgs.map(({ id, timestamp, disabled, processNodeId, depth, usage, ...rest }) => rest);

  const toolCallTurn = (id: string, callId: string, nodeId: string, content = ''): FlujoChatMessage =>
    ({
      role: 'assistant',
      content,
      id,
      timestamp: 1,
      processNodeId: nodeId,
      tool_calls: [{ id: callId, type: 'function', function: { name: 'mcp_x', arguments: '{}' } }],
    } as FlujoChatMessage);
  const nodeToolResult = (id: string, callId: string, nodeId: string): FlujoChatMessage =>
    ({ role: 'tool', tool_call_id: callId, content: 'res', id, timestamp: 1, processNodeId: nodeId } as FlujoChatMessage);
  const nodeAssistant = (content: string, id: string, nodeId: string): FlujoChatMessage =>
    ({ role: 'assistant', content, id, timestamp: 1, processNodeId: nodeId } as FlujoChatMessage);

  it('marks every non-system message as SENT when nothing is folded/scoped/stripped', () => {
    const threaded = [sys('NODE', 'node-sys'), user('hi', 'u1'), assistant('hello', 'a1')];
    const snap = deriveModelInputView({
      threaded,
      foldedView: threaded,
      scopedView: threaded,
      systemContent: 'NODE',
      inputMode: 'full-history',
    });

    expect(snap.systemMessage).toEqual({ content: 'NODE' });
    expect(snap.provenance.map((p) => [p.id, p.status])).toEqual([
      ['node-sys', 'system'],
      ['u1', 'sent'],
      ['a1', 'sent'],
    ]);
    expect(snap.counts).toEqual({ threaded: 3, sent: 2, folded: 0, scopedOut: 0, handoffStripped: 0 });
    // The SENT wire view must exactly equal what toApiMessages sends.
    expect(stripInternal(snap.wireMessages)).toEqual(toApiMessages(threaded));
  });

  it('classifies handoff plumbing as HANDOFF-STRIPPED (and matches toApiMessages)', () => {
    const threaded = [
      sys('NODE', 'node-sys'),
      user('task', 'u1'),
      handoffAssistant('a-ho', 'call-1'), // pure routing, no text
      toolResult('t-ho', 'call-1', '{}'),
    ];
    const snap = deriveModelInputView({
      threaded,
      foldedView: threaded,
      scopedView: threaded,
      systemContent: 'NODE',
      inputMode: 'full-history',
    });

    expect(snap.provenance.map((p) => [p.id, p.status])).toEqual([
      ['node-sys', 'system'],
      ['u1', 'sent'],
      ['a-ho', 'handoff-stripped'],
      ['t-ho', 'handoff-stripped'],
    ]);
    expect(snap.counts.handoffStripped).toBe(2);
    expect(snap.counts.sent).toBe(1);
    expect(stripInternal(snap.wireMessages)).toEqual(toApiMessages(threaded));
  });

  it('classifies a collapsed node output as FOLDED', () => {
    const threaded = [
      sys('NODE', 'node-sys'),
      user('q', 'u1'),
      toolCallTurn('a-call', 'c1', 'nodeX'),
      nodeToolResult('t1', 'c1', 'nodeX'),
      nodeAssistant('done', 'a-final', 'nodeX'),
    ];
    const foldedView = collapseNodeOutputs(threaded, new Set(['nodeX']));
    // Sanity: the settled tool exchange was dropped, the text response survived.
    expect(foldedView.map((m) => m.id)).toEqual(['node-sys', 'u1', 'a-final']);

    const snap = deriveModelInputView({
      threaded,
      foldedView,
      scopedView: foldedView,
      systemContent: 'NODE',
      inputMode: 'full-history',
    });

    expect(snap.provenance.map((p) => [p.id, p.status])).toEqual([
      ['node-sys', 'system'],
      ['u1', 'sent'],
      ['a-call', 'folded'],
      ['t1', 'folded'],
      ['a-final', 'sent'],
    ]);
    expect(snap.counts).toMatchObject({ folded: 2, sent: 2 });
    expect(stripInternal(snap.wireMessages)).toEqual(toApiMessages(foldedView));
  });

  it('classifies inputMode narrowing as SCOPED-OUT', () => {
    const threaded = [
      sys('NODE', 'node-sys'),
      user('old', 'u1'),
      assistant('old-reply', 'a1'),
      user('recent', 'u2'),
      assistant('reply', 'a2'),
    ];
    const scopedView = scopeMessagesForInput(threaded, 'latest-message');
    expect(scopedView.map((m) => m.id)).toEqual(['node-sys', 'u2', 'a2']);

    const snap = deriveModelInputView({
      threaded,
      foldedView: threaded,
      scopedView,
      systemContent: 'NODE',
      inputMode: 'latest-message',
    });

    expect(snap.provenance.map((p) => [p.id, p.status])).toEqual([
      ['node-sys', 'system'],
      ['u1', 'scoped-out'],
      ['a1', 'scoped-out'],
      ['u2', 'sent'],
      ['a2', 'sent'],
    ]);
    expect(snap.counts).toMatchObject({ scopedOut: 2, sent: 2 });
    expect(stripInternal(snap.wireMessages)).toEqual(toApiMessages(scopedView));
  });

  it('carries conversation content only — no credentials — and a null system when absent', () => {
    const threaded = [user('hi', 'u1')];
    const snap = deriveModelInputView({
      threaded,
      foldedView: threaded,
      scopedView: threaded,
      systemContent: null,
    });
    expect(snap.systemMessage).toBeNull();
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toMatch(/apiKey|api_key|Authorization/i);
  });
});
