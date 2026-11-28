import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Model } from '@/shared/types';

const loadModelsMock = jest.fn();
const getModelMock = jest.fn();
const loadItemMock = jest.fn();
const transcriptionCreateMock = jest.fn();

jest.mock('@/backend/services/model', () => ({
  modelService: {
    loadModels: (...args: unknown[]) => loadModelsMock(...args),
    getModel: (...args: unknown[]) => getModelMock(...args),
  },
}));
jest.mock('@/backend/services/model/encryption', () => ({ resolveAndDecryptApiKey: async () => 'resolved-secret' }));
jest.mock('@/backend/services/model/openaiClient', () => ({
  createOpenAIClient: () => ({ audio: { transcriptions: { create: transcriptionCreateMock } } }),
  getProviderDefaultHeaders: () => ({}),
}));
jest.mock('@/utils/storage/backend', () => ({ loadItem: (...args: unknown[]) => loadItemMock(...args) }));

import { transcribeChatAudio } from '@/backend/services/chatAttachments/audioTranscript';

const model = (id: string, name: string, extra: Partial<Model> = {}): Model =>
  ({ id, name, displayName: name, ApiKey: 'encrypted', baseUrl: 'https://api.example.test/v1', provider: 'openai', adapter: 'openai', ...extra });

const chat = model('chat', 'gpt-5');
const whisper = model('whisper', 'whisper-1');
const chosen = model('chosen', 'my-speech-endpoint');

async function sound(name: string): Promise<Uint8Array> {
  return readFile(path.join(process.cwd(), '__tests__', 'fixtures', 'chat-attachments', name));
}

describe('transcripts of chat sound files (#1224)', () => {
  beforeEach(() => {
    loadModelsMock.mockReset().mockResolvedValue([chat, whisper, chosen]);
    getModelMock.mockReset().mockImplementation(async (id: string) => [chat, whisper, chosen].find(entry => entry.id === id) ?? null);
    loadItemMock.mockReset().mockResolvedValue({ speech: { enabled: true, transcriptionModelId: 'chosen' } });
    transcriptionCreateMock.mockReset().mockResolvedValue({ text: ' The beans need water. ' });
  });

  it('uses the transcription model from Settings > Speech and sends the sound with its type', async () => {
    const bytes = await sound('sample.mp3');
    await expect(transcribeChatAudio({ bytes, mimeType: 'audio/mpeg', name: 'memo.mp3' }))
      .resolves.toEqual({ kind: 'text', text: 'The beans need water.' });
    const [request] = transcriptionCreateMock.mock.calls[0];
    expect(request.model).toBe('my-speech-endpoint');
    expect(request.file.name).toBe('memo.mp3');
    expect(request.file.type).toBe('audio/mpeg');
    expect(Buffer.from(await request.file.arrayBuffer())).toEqual(Buffer.from(bytes));
  });

  it('makes each transcript once and tries again after a failure', async () => {
    const bytes = await sound('sample.wav');
    transcriptionCreateMock.mockRejectedValueOnce(new Error('network down'));
    await expect(transcribeChatAudio({ bytes, mimeType: 'audio/wav', name: 'a.wav' }))
      .resolves.toEqual({ kind: 'failed', reason: 'the transcription service did not answer' });
    await expect(transcribeChatAudio({ bytes, mimeType: 'audio/wav', name: 'a.wav' })).resolves.toMatchObject({ kind: 'text' });
    await expect(transcribeChatAudio({ bytes, mimeType: 'audio/wav', name: 'a.wav' })).resolves.toMatchObject({ kind: 'text' });
    expect(transcriptionCreateMock).toHaveBeenCalledTimes(2);
  });

  it('finds a transcription model by its name when none is chosen', async () => {
    loadItemMock.mockResolvedValue({ speech: { enabled: true } });
    await transcribeChatAudio({ bytes: await sound('sample.ogg'), mimeType: 'audio/ogg', name: 'note.ogg' });
    expect(transcriptionCreateMock.mock.calls[0][0].model).toBe('whisper-1');
  });

  it('sends .opus sound as Ogg, which transcription services take', async () => {
    await transcribeChatAudio({ bytes: Buffer.from('opus-bytes'), mimeType: 'audio/opus', name: 'voice.opus' });
    const [request] = transcriptionCreateMock.mock.calls[0];
    expect([request.file.name, request.file.type]).toEqual(['voice.ogg', 'audio/ogg']);
  });

  it('says when no transcription model is set up or the format cannot be transcribed', async () => {
    loadItemMock.mockResolvedValue(undefined);
    loadModelsMock.mockResolvedValue([chat, model('owned', 'whisper-1', { ownerCredentialBinding: { ownerId: 'o', credentialId: 'c' } })]);
    await expect(transcribeChatAudio({ bytes: Buffer.from('x'), mimeType: 'audio/wav', name: 'x.wav' })).resolves.toEqual({ kind: 'no-model' });
    await expect(transcribeChatAudio({ bytes: Buffer.from('x'), mimeType: 'audio/aac', name: 'x.aac' })).resolves.toEqual({ kind: 'unsupported-format' });
    expect(transcriptionCreateMock).not.toHaveBeenCalled();
  });

  it('reports what the transcription service said when it refuses', async () => {
    transcriptionCreateMock.mockResolvedValueOnce({ text: '   ' });
    await expect(transcribeChatAudio({ bytes: Buffer.from('silence'), mimeType: 'audio/wav', name: 'quiet.wav' }))
      .resolves.toEqual({ kind: 'failed', reason: 'The transcription provider returned no text' });
  });
});
