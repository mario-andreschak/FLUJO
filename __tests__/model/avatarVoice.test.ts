jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/execution/flow/conversationLog', () => ({ recoverConversationTranscript: jest.fn() }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn() }));
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: jest.fn(() => 'default-workspace') }));
jest.mock('@/backend/services/model', () => ({ modelService: { loadModels: jest.fn(async () => []) } }));
jest.mock('@/backend/services/avatar/connectionDiscovery', () => ({ discoverAvatarConnections: jest.fn(async () => ({ candidates: [{ label: 'Codex', runtime: 'available', authentication: 'login-detected', nextAction: 'use-and-test' }] })) }));
jest.mock('@/backend/services/avatar/workModel', () => ({ readAvatarWorkModel: jest.fn(async () => null) }));
jest.mock('@/backend/execution/extensions', () => ({ assertExecutionConversationAccess: jest.fn(async () => {}), assertExecutionStateAccess: jest.fn(async () => {}) }));
import { canonicalVoiceResult, handleAvatarVoice, handleAuthenticatedAvatarVoice, type TrustedAvatarVoiceContext } from '@/backend/services/avatar/voice';
import { assertExecutionConversationAccess, assertExecutionStateAccess } from '@/backend/execution/extensions';
import { PublicError } from '@/vendor/avatar/server/support.mjs';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { recoverConversationTranscript } from '@/backend/execution/flow/conversationLog';
import { getCurrentWorkspace } from '@/utils/workspace';
import { loadItem } from '@/utils/storage/backend';
import { modelService } from '@/backend/services/model';
import { discoverAvatarConnections } from '@/backend/services/avatar/connectionDiscovery';
import { readAvatarWorkModel } from '@/backend/services/avatar/workModel';
import { createHash } from 'node:crypto';

const request = (body: object, id = crypto.randomUUID()) => new Request('http://localhost/api/avatar/native-turn', { method: 'POST', headers: { 'x-flujo-avatar-client': id, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const state = (status = 'completed') => ({ conversationId: 'conversation', status, messages: [] });
const transcript = (id = 'reply') => ({ messages: [{ id: 'request', role: 'user', content: 'Work' }, { id, role: 'assistant', content: 'A recorded result. <flujo-ui-actions>{"actions":[]}</flujo-ui-actions>' }], source: 'durable-log' });
const trusted = (scopeKey = crypto.randomUUID()) => {
  const controller = new AbortController();
  const context: TrustedAvatarVoiceContext = { workspace: 'default-workspace', scopeKey, revokeSignal: controller.signal, recheck: jest.fn(async () => {}) };
  return { context, controller };
};
const recordingPayload = () => {
  const wav = Buffer.alloc(48);
  wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
  return { audio: wav.toString('base64'), format: 'wav', avatar: 'moss', locale: 'en' };
};
const nativeWire = (text = 'Recorded reply.') => [
  { choices: [{ index: 0, delta: { audio: { id: 'audio', transcript: text, data: 'AQACAA==' } } }] },
  { choices: [{ index: 0, delta: { audio: { expires_at: 2000000000 } } }] },
  { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.001 } }, '[DONE]',
].map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
const waitForCondition = async (condition: () => boolean) => {
  for (let index = 0; index < 100 && !condition(); index++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
};
describe('avatar native voice uses canonical Flujo results', () => {
  it('uses Pocket without an online key, reading and rechecking the saved reply', async () => {
    delete process.env.FLUJO_AVATAR_OPENROUTER_KEY;
    process.env.FLUJO_AVATAR_POCKET_ORIGIN = 'http://127.0.0.1:43947';
    const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.writeUInt32LE(40,4); bytes.write('WAVEfmt ',8);
    bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22); bytes.writeUInt32LE(24000,24);
    bytes.writeUInt32LE(48000,28); bytes.writeUInt16LE(2,32); bytes.writeUInt16LE(16,34); bytes.write('data',36); bytes.writeUInt32LE(4,40);
    const original = global.fetch;
    global.fetch = jest.fn(async (_url, options) => {
      expect(_url).toBe('http://127.0.0.1:43947/speech');
      expect(JSON.parse(String(options?.body))).toEqual({ text: 'A recorded result.', locale: 'en' });
      expect(options?.headers).toEqual({ 'content-type': 'application/json' });
      return new Response(bytes);
    }) as typeof fetch;
    try {
      FlowExecutor.conversationStates.set('conversation', state() as never);
      const response = await handleAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'en' }), 'local-speech');
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('audio/wav');
      expect((await response.arrayBuffer()).byteLength).toBe(48);
      expect(recoverConversationTranscript).toHaveBeenCalledTimes(4);
      expect((await handleAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', text: 'Invented success', locale: 'en' }), 'local-speech')).status).toBe(400);
    } finally { global.fetch = original; delete process.env.FLUJO_AVATAR_POCKET_ORIGIN; }
  });
  it('does not return local audio when the canonical reply changes during synthesis', async () => {
    process.env.FLUJO_AVATAR_POCKET_ORIGIN = 'http://127.0.0.1:43947';
    FlowExecutor.conversationStates.set('conversation', state() as never);
    const original = global.fetch;
    global.fetch = jest.fn(async () => {
      jest.mocked(recoverConversationTranscript).mockResolvedValue({ messages: [{ id: 'reply', role: 'assistant', content: 'Changed' }], source: 'snapshot' } as never);
      return new Response('ignored');
    }) as typeof fetch;
    try {
      const response = await handleAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'de' }), 'local-speech');
      expect(response.status).toBe(409); expect((await response.json()).code).toBe('result_not_current');
    } finally { global.fetch = original; delete process.env.FLUJO_AVATAR_POCKET_ORIGIN; }
  });
  beforeEach(() => {
    jest.clearAllMocks(); FlowExecutor.conversationStates.clear();
    process.env.FLUJO_AVATAR_OPENROUTER_KEY = 'TEST_ONLY';
    jest.mocked(getCurrentWorkspace).mockReturnValue('default-workspace');
    jest.mocked(loadItem).mockResolvedValue(undefined);
    jest.mocked(recoverConversationTranscript).mockResolvedValue(transcript() as never);
    jest.mocked(modelService.loadModels).mockResolvedValue([]);
    jest.mocked(readAvatarWorkModel).mockResolvedValue(null);
    jest.mocked(assertExecutionConversationAccess).mockResolvedValue(undefined);
    jest.mocked(assertExecutionStateAccess).mockResolvedValue(undefined);
  });
  afterEach(() => { delete process.env.FLUJO_AVATAR_OPENROUTER_KEY; });
  it('reads durable public root replies and removes UI action syntax', async () => {
    FlowExecutor.conversationStates.set('conversation', state() as never);
    expect(await canonicalVoiceResult('conversation', 'reply')).toEqual({ reply: 'A recorded result.', mode: 'flujo', status: 'completed' });
    expect(assertExecutionStateAccess).toHaveBeenCalledWith(FlowExecutor.conversationStates.get('conversation'), 'conversation');
  });
  it('checks conversation authority before lookup and state authority before transcript recovery', async () => {
    const denied = new Error('private denial');
    jest.mocked(assertExecutionConversationAccess).mockRejectedValueOnce(denied);
    await expect(canonicalVoiceResult('conversation', 'reply')).rejects.toBe(denied);
    expect(loadItem).not.toHaveBeenCalled(); expect(recoverConversationTranscript).not.toHaveBeenCalled();
    FlowExecutor.conversationStates.set('conversation', state() as never);
    jest.mocked(assertExecutionStateAccess).mockRejectedValueOnce(denied);
    await expect(canonicalVoiceResult('conversation', 'reply')).rejects.toBe(denied);
    expect(recoverConversationTranscript).not.toHaveBeenCalled();
  });
  it('refuses running work, stale replies, child contributions and path traversal', async () => {
    FlowExecutor.conversationStates.set('conversation', state('running') as never);
    await expect(canonicalVoiceResult('conversation', 'reply')).rejects.toMatchObject({ code: 'result_not_ready' });
    FlowExecutor.conversationStates.set('conversation', state() as never);
    await expect(canonicalVoiceResult('conversation', 'older')).rejects.toMatchObject({ code: 'result_not_current' });
    jest.mocked(recoverConversationTranscript).mockResolvedValue({ messages: [{ id: 'reply', role: 'assistant', content: 'Child', depth: 1 }], source: 'snapshot' } as never);
    await expect(canonicalVoiceResult('conversation', 'reply')).rejects.toMatchObject({ code: 'result_not_current' });
    await expect(canonicalVoiceResult('../other', 'reply')).rejects.toMatchObject({ code: 'invalid_voice_request' });
  });
  it('rejects browser-supplied narration claims before looking up a conversation', async () => {
    const response = await handleAvatarVoice(request({ reply: 'I installed everything.', locale: 'es' }), 'native-result-receipt');
    expect(response.status).toBe(400); expect(recoverConversationTranscript).not.toHaveBeenCalled();
  });
  it('issues a bounded result receipt once per session and revokes it on workspace change', async () => {
    const client = crypto.randomUUID(); FlowExecutor.conversationStates.set('conversation', state() as never);
    const payload = { conversationId: 'conversation', messageId: 'reply', locale: 'es' };
    const receipt = await (await handleAvatarVoice(request(payload, client), 'native-result-receipt')).json();
    expect(receipt.taskId).toEqual(expect.any(String));
    expect((await handleAvatarVoice(request(payload, client), 'native-result-receipt')).status).toBe(409);
    jest.mocked(getCurrentWorkspace).mockReturnValue('other-workspace');
    expect((await handleAvatarVoice(request({ taskId: receipt.taskId, avatar: 'moss', locale: 'es' }, client), 'native-result')).status).toBe(409);
  });
  it.each([null, false, {}, '', 'a'.repeat(63), 'A'.repeat(64)])('refuses malformed expected result digest %j before canonical lookup', async expectedResultDigest => {
    const auth = trusted();
    const response = await handleAuthenticatedAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'en', expectedResultDigest }), 'native-result-receipt', auth.context);
    expect(response.status).toBe(400); expect(recoverConversationTranscript).not.toHaveBeenCalled();
  });
  it('refuses a changed reviewed projection before offering a receipt and permits the matching result', async () => {
    const client = crypto.randomUUID(), auth = trusted(); FlowExecutor.conversationStates.set('conversation', state() as never);
    const expectedResultDigest = createHash('sha256').update(JSON.stringify({ reply: 'A recorded result.', mode: 'flujo', status: 'completed' })).digest('hex');
    const payload = { conversationId: 'conversation', messageId: 'reply', locale: 'en', expectedResultDigest };
    jest.mocked(recoverConversationTranscript).mockResolvedValueOnce({ messages: [{ id: 'reply', role: 'assistant', content: 'Changed after independent review.' }], source: 'snapshot' } as never);
    expect((await handleAuthenticatedAvatarVoice(request(payload, client), 'native-result-receipt', auth.context)).status).toBe(409);
    const matching = await handleAuthenticatedAvatarVoice(request(payload, client), 'native-result-receipt', auth.context);
    expect(matching.status).toBe(200); expect(await matching.json()).toEqual({ taskId: expect.any(String) });
    expect((await handleAuthenticatedAvatarVoice(request(payload, client), 'native-result-receipt', auth.context)).status).toBe(409);
  });
  it('keeps the reviewed digest current after receipt issuance without admitting a changed reply to the provider', async () => {
    const original = global.fetch, fetchMock = jest.fn(); global.fetch = fetchMock;
    try {
      const client = crypto.randomUUID(), auth = trusted(); FlowExecutor.conversationStates.set('conversation', state() as never);
      const expectedResultDigest = createHash('sha256').update(JSON.stringify({ reply: 'A recorded result.', mode: 'flujo', status: 'completed' })).digest('hex');
      const receiptResponse = await handleAuthenticatedAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'en', expectedResultDigest }, client), 'native-result-receipt', auth.context);
      expect(receiptResponse.status).toBe(200); const receipt = await receiptResponse.json();
      jest.mocked(recoverConversationTranscript).mockResolvedValue({ messages: [{ id: 'reply', role: 'assistant', content: 'Unreviewed replacement.' }], source: 'snapshot' } as never);
      expect((await handleAuthenticatedAvatarVoice(request({ taskId: receipt.taskId, avatar: 'moss', locale: 'en' }, client), 'native-result', auth.context)).status).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { global.fetch = original; }
  });
  it.each([undefined, 'en', 'es', 'pt'])('boots voice on an empty model list with the chosen/default locale %s', async locale => {
    const original = global.fetch;
    const wire = [
      { choices: [{ index: 0, delta: { audio: { id: 'audio', transcript: 'Vamos a conectar tu IA.', data: 'AQACAA==' } } }] },
      { choices: [{ index: 0, delta: { audio: { expires_at: 2000000000 } } }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.001 } }, '[DONE]',
    ];
    global.fetch = jest.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages.some((message: { content: string }) => message.content.includes('login-detected'))).toBe(true);
      const label = locale === 'es' ? 'Encontrar mi IA' : locale === 'pt' ? 'Encontrar minha IA' : 'Find my AI';
      expect(body.messages.some((message: { content: string }) => message.content.includes(`"findAIButton":"${label}"`))).toBe(true);
      expect(body.messages[0].content).toContain(locale === 'es' ? 'español' : locale === 'pt' ? 'português do Brasil' : 'Speak natural, clear English');
      expect(body.tools).toBeUndefined();
      return new Response(wire.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    try {
      const response = await handleAvatarVoice(request({ message: 'Help me connect my AI.', avatar: 'moss', locale }), 'native-turn');
      expect(response.status).toBe(200);
      const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
      expect(events[0].type).toBe('start'); expect(events.at(-1).type).toBe('complete');
    } finally { global.fetch = original; }
  });
  it('recognizes a work recording without generating a second spoken setup response', async () => {
    const original = global.fetch;
    const wav = Buffer.alloc(48);
    wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
    const fetchMock = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ text: 'Build a useful flow.' })); global.fetch = fetchMock;
    try {
      const response = await handleAvatarVoice(request({ audio: wav.toString('base64'), format: 'wav', avatar: 'moss', locale: 'en' }), 'native-input');
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ text: 'Build a useful flow.' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
      expect(discoverAvatarConnections).not.toHaveBeenCalled(); expect(modelService.loadModels).not.toHaveBeenCalled();
      expect((await handleAvatarVoice(request({ message: 'Fake a recording.', avatar: 'moss', locale: 'en' }), 'native-input')).status).toBe(400);
    } finally { global.fetch = original; }
  });
  it('uses the current verified model and omits obsolete heard setup advice and model inventories', async () => {
    const original = global.fetch, client = crypto.randomUUID();
    let responseText = 'Use the old model.';
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    global.fetch = jest.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const frames = [
        { choices: [{ index: 0, delta: { audio: { id: 'audio', transcript: responseText, data: 'AQACAA==' } } }] },
        { choices: [{ index: 0, delta: { audio: { expires_at: 2000000000 } } }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.001 } }, '[DONE]',
      ];
      return new Response(frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    try {
      const initial = await handleAvatarVoice(request({ message: 'Connect me.', avatar: 'moss', locale: 'en' }, client), 'native-turn');
      const events = (await initial.text()).trim().split('\n').map(line => JSON.parse(line));
      await handleAvatarVoice(request({ turnId: events[0].turnId, locale: 'en', playedSamples: 2, complete: true }, client), 'native-played');
      jest.mocked(modelService.loadModels).mockResolvedValue([{ id: 'chosen', name: 'current-model', displayName: 'My current AI', ApiKey: 'NEVER_FORWARD' }]);
      jest.mocked(readAvatarWorkModel).mockResolvedValue({ modelId: 'chosen', label: 'My current AI', ready: true, verifiedAt: 1 });
      jest.mocked(discoverAvatarConnections).mockClear(); responseText = 'Done.';
      const response = await handleAvatarVoice(request({ message: 'Work.', avatar: 'moss', locale: 'en' }, client), 'native-turn');
      await response.text();
      const current = JSON.stringify(bodies[1]);
      expect(current).toContain('current-model'); expect(current).not.toContain('Use the old model.'); expect(current).not.toContain('"options"'); expect(current).not.toContain('NEVER_FORWARD');
      expect(discoverAvatarConnections).not.toHaveBeenCalled();
      expect(bodies[1].messages[0].content).toContain('one short');
    } finally { global.fetch = original; }
  });
  it('binds narration receipts to authenticated principal and credential revision, isolated from local sessions', async () => {
    FlowExecutor.conversationStates.set('conversation', state() as never);
    const client = crypto.randomUUID(), first = trusted(), other = trusted(), revised = trusted();
    const receipt = await (await handleAuthenticatedAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'en' }, client), 'native-result-receipt', first.context)).json();
    expect(receipt.taskId).toEqual(expect.any(String));
    const payload = { taskId: receipt.taskId, avatar: 'moss', locale: 'en' };
    expect((await handleAuthenticatedAvatarVoice(request(payload, client), 'native-result', other.context)).status).toBe(409);
    expect((await handleAuthenticatedAvatarVoice(request(payload, client), 'native-result', revised.context)).status).toBe(409);
    expect((await handleAvatarVoice(request(payload, client), 'native-result')).status).toBe(409);
    first.controller.abort(); other.controller.abort(); revised.controller.abort();
  });
  it('commits only one receipt when canonical lookup races for the same result', async () => {
    FlowExecutor.conversationStates.set('conversation', state() as never);
    const auth = trusted(), client = crypto.randomUUID(), payload = { conversationId: 'conversation', messageId: 'reply', locale: 'en' };
    const responses = await Promise.all([
      handleAuthenticatedAvatarVoice(request(payload, client), 'native-result-receipt', auth.context),
      handleAuthenticatedAvatarVoice(request(payload, client), 'native-result-receipt', auth.context),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    auth.controller.abort();
  });
  it('refuses a trusted context for another server workspace before reading a body or state', async () => {
    const auth = trusted(); const context = { ...auth.context, workspace: 'another-workspace' };
    const req = request({}), read = jest.fn(); Object.defineProperty(req, 'body', { value: { getReader: read } });
    expect((await handleAuthenticatedAvatarVoice(req, 'native-reset', context)).status).toBe(403);
    expect(read).not.toHaveBeenCalled(); expect(loadItem).not.toHaveBeenCalled(); expect(auth.context.recheck).not.toHaveBeenCalled();
  });
  it('rechecks authority after canonical lookup before committing a receipt', async () => {
    FlowExecutor.conversationStates.set('conversation', state() as never);
    const auth = trusted(); let allowed = true;
    const context = { ...auth.context, recheck: jest.fn(async () => { if (!allowed) throw new PublicError(403, 'voice_access_revoked', 'Voice session ended.'); }) };
    jest.mocked(recoverConversationTranscript).mockImplementationOnce(async () => { allowed = false; return transcript() as never; });
    const response = await handleAuthenticatedAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'en' }), 'native-result-receipt', context);
    expect(response.status).toBe(403); expect((await response.json()).taskId).toBeUndefined();
  });
  it('rejects a receipt superseded by a new root reply without a provider request', async () => {
    const original = global.fetch; global.fetch = jest.fn();
    const auth = trusted(), client = crypto.randomUUID(); FlowExecutor.conversationStates.set('conversation', state() as never);
    try {
      const receipt = await (await handleAuthenticatedAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'en' }, client), 'native-result-receipt', auth.context)).json();
      jest.mocked(recoverConversationTranscript).mockResolvedValue(transcript('newer-reply') as never);
      const response = await handleAuthenticatedAvatarVoice(request({ taskId: receipt.taskId, avatar: 'moss', locale: 'en' }, client), 'native-result', auth.context);
      expect(response.status).toBe(409); expect(global.fetch).not.toHaveBeenCalled();
    } finally { global.fetch = original; auth.controller.abort(); }
  });
  it('rejects changed canonical reply bytes even when its message identity is unchanged', async () => {
    const auth = trusted(), client = crypto.randomUUID(); FlowExecutor.conversationStates.set('conversation', state() as never);
    const receipt = await (await handleAuthenticatedAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'en' }, client), 'native-result-receipt', auth.context)).json();
    jest.mocked(recoverConversationTranscript).mockResolvedValue({ ...transcript(), messages: [{ id: 'reply', role: 'assistant', content: 'Changed content.' }] } as never);
    expect((await handleAuthenticatedAvatarVoice(request({ taskId: receipt.taskId, avatar: 'moss', locale: 'en' }, client), 'native-result', auth.context)).status).toBe(409);
    auth.controller.abort();
  });
  it('revalidates canonical currency after model loading and before provider admission', async () => {
    const original = global.fetch; global.fetch = jest.fn();
    const auth = trusted(), client = crypto.randomUUID(); FlowExecutor.conversationStates.set('conversation', state() as never);
    try {
      const receipt = await (await handleAuthenticatedAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'en' }, client), 'native-result-receipt', auth.context)).json();
      jest.mocked(modelService.loadModels).mockImplementationOnce(async () => { jest.mocked(recoverConversationTranscript).mockResolvedValue(transcript('newer') as never); return []; });
      expect((await handleAuthenticatedAvatarVoice(request({ taskId: receipt.taskId, avatar: 'moss', locale: 'en' }, client), 'native-result', auth.context)).status).toBe(409);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally { global.fetch = original; auth.controller.abort(); }
  });
  it('revokes every client receipt permanently even when a fresh context uses the same scope key', async () => {
    const auth = trusted(), clients = [crypto.randomUUID(), crypto.randomUUID()]; FlowExecutor.conversationStates.set('conversation', state() as never);
    const receipts = await Promise.all(clients.map(async client => (await handleAuthenticatedAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'en' }, client), 'native-result-receipt', auth.context)).json()));
    auth.controller.abort();
    const renewed = trusted(auth.context.scopeKey);
    for (const [index, client] of clients.entries()) expect((await handleAuthenticatedAvatarVoice(request({ taskId: receipts[index].taskId, avatar: 'moss', locale: 'en' }, client), 'native-result', renewed.context)).status).toBe(409);
    renewed.controller.abort();
  });
  it('cancels one caller during a stalled authority check without revoking another client under the same grant', async () => {
    const original = global.fetch, auth = trusted(), caller = new AbortController(), clientB = crypto.randomUUID();
    FlowExecutor.conversationStates.set('conversation', state() as never);
    let checking = false, resume!: () => void, timeout: ReturnType<typeof setTimeout> | undefined;
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const contextA = { ...auth.context, recheck: async () => { checking = true; await blocked; } };
    global.fetch = jest.fn(async () => new Response(nativeWire('A recorded result.'), { headers: { 'Content-Type': 'text/event-stream' } }));
    try {
      const receiptB = await (await handleAuthenticatedAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'en' }, clientB), 'native-result-receipt', auth.context)).json();
      const reqA = new Request('http://localhost/api/avatar/native-reset', { method: 'POST', headers: { 'x-flujo-avatar-client': crypto.randomUUID(), 'Content-Type': 'application/json' }, body: '{}', signal: caller.signal });
      const pendingA = handleAuthenticatedAvatarVoice(reqA, 'native-reset', contextA);
      await waitForCondition(() => checking); caller.abort();
      const responseA = await Promise.race([pendingA, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Canceled caller waited again on the shared check.')), 300); })]);
      expect(responseA.status).toBe(499); expect(auth.controller.signal.aborted).toBe(false);
      const responseB = await handleAuthenticatedAvatarVoice(request({ taskId: receiptB.taskId, avatar: 'moss', locale: 'en' }, clientB), 'native-result', auth.context);
      expect(responseB.status).toBe(200);
      expect((await responseB.text()).trim().split('\n').map(line => JSON.parse(line)).at(-1).type).toBe('complete');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(timeout); resume(); global.fetch = original; auth.controller.abort(); }
  });
  it('keeps reset body exact and clears backend receipt provenance', async () => {
    const auth = trusted(), client = crypto.randomUUID(); FlowExecutor.conversationStates.set('conversation', state() as never);
    const receipt = await (await handleAuthenticatedAvatarVoice(request({ conversationId: 'conversation', messageId: 'reply', locale: 'en' }, client), 'native-result-receipt', auth.context)).json();
    expect((await handleAuthenticatedAvatarVoice(request({ locale: 'en' }, client), 'native-reset', auth.context)).status).toBe(400);
    expect((await handleAuthenticatedAvatarVoice(request({}, client), 'native-reset', auth.context)).status).toBe(200);
    expect((await handleAuthenticatedAvatarVoice(request({ taskId: receipt.taskId, avatar: 'moss', locale: 'en' }, client), 'native-result', auth.context)).status).toBe(409);
    auth.controller.abort();
  });
  it.each(['revoke', 'caller'])('interrupts a stalled body read on %s and cancels its source', async mode => {
    const auth = trusted(), caller = new AbortController(), canceled = jest.fn(); let reading = false;
    const req = new Request('http://localhost/api/avatar/native-reset', { method: 'POST', headers: { 'x-flujo-avatar-client': crypto.randomUUID() }, body: '{}', signal: caller.signal });
    Object.defineProperty(req, 'body', { value: new ReadableStream({ pull() { reading = true; }, cancel: canceled }) });
    const pending = handleAuthenticatedAvatarVoice(req, 'native-reset', auth.context);
    await waitForCondition(() => reading);
    (mode === 'revoke' ? auth.controller : caller).abort();
    const response = await pending;
    expect(response.status).toBe(mode === 'revoke' ? 403 : 499); expect(canceled).toHaveBeenCalled();
    auth.controller.abort();
  });
  it('aborts transcription and suppresses a provider response arriving after revocation', async () => {
    const original = global.fetch, auth = trusted(); let settle!: (response: Response) => void, providerSignal: AbortSignal | undefined;
    const canceled = jest.fn();
    global.fetch = jest.fn((_input, init) => { providerSignal = init?.signal ?? undefined; return new Promise<Response>(resolve => { settle = resolve; }); });
    try {
      const pending = handleAuthenticatedAvatarVoice(request(recordingPayload()), 'native-input', auth.context);
      await waitForCondition(() => Boolean(providerSignal)); auth.controller.abort();
      expect((await pending).status).toBe(403); expect(providerSignal?.aborted).toBe(true);
      settle(new Response(new ReadableStream({ cancel: canceled })));
      await waitForCondition(() => canceled.mock.calls.length === 1);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally { global.fetch = original; auth.controller.abort(); }
  });
  it('interrupts transcription body reads after provider headers without waiting for EOF', async () => {
    const original = global.fetch, auth = trusted(), canceled = jest.fn(); let reading = false;
    const provider = new Response(new ReadableStream({ pull() { reading = true; }, cancel: canceled }));
    global.fetch = jest.fn(async () => provider);
    try {
      const pending = handleAuthenticatedAvatarVoice(request(recordingPayload()), 'native-input', auth.context);
      await waitForCondition(() => reading); auth.controller.abort();
      expect((await pending).status).toBe(403); expect(canceled).toHaveBeenCalled();
      await waitForCondition(() => !provider.body!.locked);
    } finally { global.fetch = original; auth.controller.abort(); }
  });
  it.each(['eof', 'error'])('releases the provider reader after transcription %s', async mode => {
    const original = global.fetch, auth = trusted();
    const provider = mode === 'eof' ? Response.json({ text: 'Recognized work.' }) : new Response(new ReadableStream({ pull(controller) { controller.error(new Error('Fixture stream failure.')); } }));
    global.fetch = jest.fn(async () => provider);
    try {
      const response = await handleAuthenticatedAvatarVoice(request(recordingPayload()), 'native-input', auth.context);
      expect(response.status).toBe(mode === 'eof' ? 200 : 502);
      await waitForCondition(() => !provider.body!.locked);
    } finally { global.fetch = original; auth.controller.abort(); }
  });
  it('retains a provider failure when the authenticated lifetime is still valid', async () => {
    const original = global.fetch, auth = trusted();
    global.fetch = jest.fn(async () => new Response('Provider unavailable.', { status: 503 }));
    try {
      const response = await handleAuthenticatedAvatarVoice(request(recordingPayload()), 'native-input', auth.context);
      expect(response.status).toBe(502); expect((await response.json()).code).toBe('voice_unavailable');
      expect(auth.context.recheck).toHaveBeenCalled();
    } finally { global.fetch = original; auth.controller.abort(); }
  });
  it('revokes NDJSON under writer backpressure, aborts the provider and never qualifies heard audio', async () => {
    const original = global.fetch, auth = trusted(), client = crypto.randomUUID(); let providerSignal: AbortSignal | undefined;
    const provider = new Response(nativeWire(), { headers: { 'Content-Type': 'text/event-stream' } });
    global.fetch = jest.fn(async (_input, init) => { providerSignal = init?.signal ?? undefined; return provider; });
    try {
      const response = await handleAuthenticatedAvatarVoice(request({ message: 'Speak.', avatar: 'moss', locale: 'en' }, client), 'native-turn', auth.context);
      expect(response.status).toBe(200);
      // Do not consume the response: the first writer.write is backpressured.
      auth.controller.abort();
      await expect(response.text()).rejects.toBeDefined(); expect(providerSignal?.aborted).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      await waitForCondition(() => !provider.body!.locked);
    } finally { global.fetch = original; auth.controller.abort(); }
  });
});
