import type { Model } from '@/shared/types/model';

const resolveKeyMock = jest.fn();
const createClientMock = jest.fn();

jest.mock('@/backend/services/model/encryption', () => ({
  resolveAndDecryptApiKey: (...args: unknown[]) => resolveKeyMock(...args),
}));
jest.mock('@/backend/services/model/openaiClient', () => ({
  createOpenAIClient: (...args: unknown[]) => createClientMock(...args),
}));

import { EmbeddingProvider } from '@/backend/services/model/embeddings';

it('denies an owner-bound embedding model before resolving credentials or sending', async () => {
  const model = {
    id: 'bound-embedding',
    name: 'text-embedding-3-small',
    ApiKey: '',
    adapter: 'openai',
    ownerCredentialBinding: null,
  } as unknown as Model;

  await expect(new EmbeddingProvider().embed(model, {
    modelId: model.name,
    text: 'sample',
  })).rejects.toThrow(/authorized model-step transport/i);
  expect(resolveKeyMock).not.toHaveBeenCalled();
  expect(createClientMock).not.toHaveBeenCalled();
});
