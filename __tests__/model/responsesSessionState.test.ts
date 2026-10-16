import { inspectJson } from '@/backend/execution/flow/compaction/jsonInspection';
import { digestCanonicalJson } from '@/backend/execution/flow/compaction/digest';
import { validateResponsesSession, validateResponsesSessions, replaceResponsesSession, responsesReplayInput,
  type ResponsesSessionState } from '@/backend/services/model/adapters/responsesSessionState';

const scope = { workspace: 'default-workspace', conversationId: 'conversation', nodeId: 'process' };
const snapshot = (): ResponsesSessionState => {
  const nativeOutput = [{ type: 'reasoning' as const, id: 'opaque-ñ', summary: [], encrypted_content: 'EXACT\nOPAQUE' }];
  const records: ResponsesSessionState['records'] = [['anchor', {
    items: [], nativeOutput, nativeInputDigest: 'b'.repeat(64), retainedChars: inspectJson(nativeOutput),
    inputLength: 1, inputDigest: 'c'.repeat(64), outputLength: 1, outputDigest: 'd'.repeat(64),
  }]];
  return { version: 1, ...scope, owner: 'a'.repeat(64), recordsDigest: digestCanonicalJson(records), records };
};

it('restores compaction and hosted-tool output without dropping their complete window', () => {
  const saved = snapshot();
  const record = saved.records[0][1];
  record.nativeOutput!.push(
    { type: 'compaction', id: 'compact-ñ', encrypted_content: 'EXACT\nCOMPACTED' },
    { type: 'web_search_call', id: 'search-ñ', status: 'completed', action: { type: 'search', query: 'Bogotá' } },
    { type: 'image_generation_call', id: 'image-ñ', status: 'completed', result: 'EXACT_IMAGE' },
  );
  record.retainedChars = inspectJson(record.nativeOutput);
  saved.recordsDigest = digestCanonicalJson(saved.records);
  expect(validateResponsesSession(JSON.parse(JSON.stringify(saved)), scope)).toEqual(saved);
});

it('rejects an intact checkpoint with an unknown or input-only output discriminator', () => {
  for (const type of ['unknown_output', 'item_reference', 'configuration_update']) {
    const saved = snapshot();
    const record = saved.records[0][1];
    (record.nativeOutput![0] as any).type = type;
    record.retainedChars = inspectJson(record.nativeOutput);
    saved.recordsDigest = digestCanonicalJson(saved.records);
    expect(validateResponsesSession(saved, scope)).toBeUndefined();
  }
});

it('normalizes SDK-only fields on a separate replay copy without changing opaque values', () => {
  const output = [
    { type: 'compaction', id: 'compact-ñ', encrypted_content: 'EXACT\nOPAQUE', created_by: 'provider-provenance' },
    { type: 'function_call', id: 'call', call_id: 'owned-call', name: 'read', arguments: '{"ñ":1}', parsed_arguments: { ñ: 1 } },
    { type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [
      { type: 'output_text', text: 'Done.', annotations: [], parsed: { local: true } },
    ] },
  ];
  const before = JSON.stringify(output);
  expect(responsesReplayInput(output)).toEqual([
    { type: 'compaction', id: 'compact-ñ', encrypted_content: 'EXACT\nOPAQUE' },
    { type: 'function_call', id: 'call', call_id: 'owned-call', name: 'read', arguments: '{"ñ":1}' },
    { type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [
      { type: 'output_text', text: 'Done.', annotations: [] },
    ] },
  ]);
  expect(JSON.stringify(output)).toBe(before);
});

it('omits non-replayable provider output without promoting it to developer authority', () => {
  const notReplayable = { type: 'additional_tools', role: 'assistant', tools: [], created_by: 'provider' };
  expect(responsesReplayInput([notReplayable])).toBeUndefined();
  expect(responsesReplayInput([notReplayable, ...snapshot().records[0][1].nativeOutput!]))
    .toEqual(snapshot().records[0][1].nativeOutput);
});

it('detaches a valid JSON checkpoint and retains exact opaque bytes', () => {
  const saved = snapshot();
  const restored = validateResponsesSession(JSON.parse(JSON.stringify(saved)), scope)!;
  expect(restored).toEqual(saved);
  restored.records[0][1].nativeOutput![0].id = 'changed';
  expect(saved.records[0][1].nativeOutput![0].id).toBe('opaque-ñ');
});

it.each([
  ['policy', (state: any) => { state.version = 0; }],
  ['workspace', (state: any) => { state.workspace = 'other'; }],
  ['conversation', (state: any) => { state.conversationId = 'other'; }],
  ['node', (state: any) => { state.nodeId = 'other'; }],
  ['owner', (state: any) => { state.owner = 'invalid'; }],
  ['negative prefix', (state: any) => { state.records[0][1].inputLength = -1; }],
  ['fractional length', (state: any) => { state.records[0][1].outputLength = 1.5; }],
  ['empty output', (state: any) => { state.records[0][1].nativeOutput = []; }],
  ['missing native lineage', (state: any) => { delete state.records[0][1].nativeInputDigest; }],
  ['false retained size', (state: any) => { state.records[0][1].retainedChars = 0; }],
  ['same-size corruption', (state: any) => { state.records[0][1].nativeOutput[0].encrypted_content = 'WRONG\nOPAQUE'; }],
  ['duplicate anchor', (state: any) => { state.records.push(state.records[0]); }],
  ['unsupported native item', (state: any) => { state.records[0][1].nativeOutput[0].type = 'item_reference'; }],
  ['oversized output', (state: any) => { state.records[0][1].nativeOutput[0].encrypted_content = 'x'.repeat(1_048_576); }],
  ['cyclic state', (state: any) => { state.extra = state; }],
])('rejects %s and leaves canonical fallback available', (_name, mutate) => {
  const state = snapshot();
  mutate(state);
  expect(validateResponsesSession(state, scope)).toBeUndefined();
});

it('rejects an intact checkpoint belonging to another configuration', () => {
  expect(validateResponsesSession(snapshot(), { ...scope, owner: 'e'.repeat(64) })).toBeUndefined();
});

it('bounds aggregate durable output across nodes, replacing and removing current ownership', () => {
  let sessions: Record<string, ResponsesSessionState> | undefined;
  for (let index = 0; index < 70; index++) {
    const state = snapshot();
    state.nodeId = 'node-' + index;
    sessions = replaceResponsesSession(sessions, state.nodeId, state);
  }
  expect(Object.keys(sessions!)).toHaveLength(64);
  expect(sessions!['node-0']).toBeUndefined();
  sessions = replaceResponsesSession(sessions, 'node-69', undefined);
  expect(sessions!['node-69']).toBeUndefined();
  const large = snapshot();
  (large.records[0][1].nativeOutput![0] as any).encrypted_content = 'x'.repeat(600_000);
  large.records[0][1].retainedChars = inspectJson(large.records[0][1].nativeOutput);
  const first = replaceResponsesSession(undefined, 'a', large);
  const second = replaceResponsesSession(first, 'b', large)!;
  expect(Object.keys(second)).toEqual(['b']);
  expect(inspectJson(second)).toBeLessThanOrEqual(1_048_576);
});

it('filters restored conversations by workspace/node and bounds the aggregate', () => {
  const saved = snapshot();
  expect(validateResponsesSessions({ process: saved, other: saved, invalid: {} }, scope)).toEqual({ process: saved });
  expect(validateResponsesSessions({ process: saved }, { ...scope, workspace: 'other' })).toBeUndefined();
  expect(validateResponsesSessions([], scope)).toBeUndefined();
});
