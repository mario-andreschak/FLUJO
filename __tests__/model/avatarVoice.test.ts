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
  it('boots voice on an empty model list using passive setup facts and Web Stream backpressure', async () => {
    const original = global.fetch;
    const wire = [
      { choices: [{ index: 0, delta: { audio: { id: 'audio', transcript: 'Vamos a conectar tu IA.', data: 'AQACAA==' } } }] },
      { choices: [{ index: 0, delta: { audio: { expires_at: 2000000000 } } }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.001 } }, '[DONE]',
    ];
    global.fetch = jest.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages.some((message: { content: string }) => message.content.includes('login-detected'))).toBe(true);
      expect(body.tools).toBeUndefined();
      return new Response(wire.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    try {
      const response = await handleAvatarVoice(request({ message: 'Hola', avatar: 'moss', locale: 'es' }), 'native-turn');
      expect(response.status).toBe(200);
      const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
      expect(events[0].type).toBe('start'); expect(events.at(-1).type).toBe('complete');
    } finally { global.fetch = original; }
  });
});
