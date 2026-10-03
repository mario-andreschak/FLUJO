jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/execution/flow/conversationLog', () => ({ recoverConversationTranscript: jest.fn() }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn() }));
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: jest.fn(() => 'default-workspace') }));
jest.mock('@/backend/services/model', () => ({ modelService: { loadModels: jest.fn(async () => []) } }));
jest.mock('@/backend/services/avatar/connectionDiscovery', () => ({ discoverAvatarConnections: jest.fn(async () => ({ candidates: [{ label: 'Codex', runtime: 'available', authentication: 'login-detected', nextAction: 'use-and-test' }] })) }));
jest.mock('@/backend/services/avatar/workModel', () => ({ readAvatarWorkModel: jest.fn(async () => null) }));
import { canonicalVoiceResult, handleAvatarVoice } from '@/backend/services/avatar/voice';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { recoverConversationTranscript } from '@/backend/execution/flow/conversationLog';
import { getCurrentWorkspace } from '@/utils/workspace';
import { loadItem } from '@/utils/storage/backend';
import { modelService } from '@/backend/services/model';
import { discoverAvatarConnections } from '@/backend/services/avatar/connectionDiscovery';
import { readAvatarWorkModel } from '@/backend/services/avatar/workModel';

const request = (body: object, id = crypto.randomUUID()) => new Request('http://localhost/api/avatar/native-turn', { method: 'POST', headers: { 'x-flujo-avatar-client': id, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const state = (status = 'completed') => ({ conversationId: 'conversation', status, messages: [] });
const transcript = (id = 'reply') => ({ messages: [{ id: 'request', role: 'user', content: 'Work' }, { id, role: 'assistant', content: 'A recorded result. <flujo-ui-actions>{"actions":[]}</flujo-ui-actions>' }], source: 'durable-log' });
describe('avatar native voice uses canonical Flujo results', () => {
  beforeEach(() => {
    jest.clearAllMocks(); FlowExecutor.conversationStates.clear();
    process.env.FLUJO_AVATAR_OPENROUTER_KEY = 'TEST_ONLY';
    jest.mocked(getCurrentWorkspace).mockReturnValue('default-workspace');
    jest.mocked(loadItem).mockResolvedValue(undefined);
    jest.mocked(recoverConversationTranscript).mockResolvedValue(transcript() as never);
    jest.mocked(modelService.loadModels).mockResolvedValue([]);
    jest.mocked(readAvatarWorkModel).mockResolvedValue(null);
  });
  afterEach(() => { delete process.env.FLUJO_AVATAR_OPENROUTER_KEY; });
  it('reads durable public root replies and removes UI action syntax', async () => {
    FlowExecutor.conversationStates.set('conversation', state() as never);
    expect(await canonicalVoiceResult('conversation', 'reply')).toEqual({ reply: 'A recorded result.', mode: 'flujo', status: 'completed' });
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
});
