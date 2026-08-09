import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { resolveCodexModelCatalogPath } from '@/backend/services/model/adapters/codexModelCatalog';

jest.mock('os', () => ({ homedir: jest.fn() }));
jest.mock('fs', () => ({
  promises: { stat: jest.fn(), readFile: jest.fn() },
}));

const homedirMock = os.homedir as jest.MockedFunction<typeof os.homedir>;
const statMock = fs.stat as jest.MockedFunction<typeof fs.stat>;
const readFileMock = fs.readFile as jest.MockedFunction<typeof fs.readFile>;

const compatibleCatalog = JSON.stringify({
  client_version: '0.147.0',
  models: [{ slug: 'gpt-5.6-sol', model_messages: { instructions_template: 'test' } }],
});

describe('resolveCodexModelCatalogPath', () => {
  const previousCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    homedirMock.mockReturnValue('C:\\Users\\test');
    statMock.mockReset();
    readFileMock.mockReset();
    readFileMock.mockResolvedValue(compatibleCatalog);
    delete process.env.CODEX_HOME;
  });

  afterAll(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  it('uses the default Codex cache when it is a file', async () => {
    statMock.mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>);

    await expect(resolveCodexModelCatalogPath()).resolves.toBe(
      path.join('C:\\Users\\test', '.codex', 'models_cache.json'),
    );
  });

  it('respects CODEX_HOME', async () => {
    process.env.CODEX_HOME = 'D:\\codex-state';
    statMock.mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>);

    await expect(resolveCodexModelCatalogPath()).resolves.toBe(
      path.join('D:\\codex-state', 'models_cache.json'),
    );
  });

  it('returns undefined when no cache exists', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    await expect(resolveCodexModelCatalogPath()).resolves.toBeUndefined();
  });

  it('rejects a catalog written by an incompatible Codex client', async () => {
    statMock.mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>);
    readFileMock.mockResolvedValue(JSON.stringify({
      client_version: '0.148.0',
      models: [{ slug: 'gpt-5.6-sol', model_messages: {} }],
    }));

    await expect(resolveCodexModelCatalogPath()).resolves.toBeUndefined();
  });

  it('rejects the legacy base_instructions catalog schema', async () => {
    statMock.mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>);
    readFileMock.mockResolvedValue(JSON.stringify({
      client_version: '0.147.0',
      models: [{ slug: 'gpt-5.6-sol', base_instructions: 'legacy' }],
    }));

    await expect(resolveCodexModelCatalogPath()).resolves.toBeUndefined();
  });

  it('rejects malformed JSON instead of handing it to Codex', async () => {
    statMock.mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>);
    readFileMock.mockResolvedValue('{');

    await expect(resolveCodexModelCatalogPath()).resolves.toBeUndefined();
  });
});
