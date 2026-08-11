import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { loadItem } from '@/utils/storage/backend';
import { resolveCodexModelCatalogPath } from '@/backend/services/model/adapters/codexModelCatalog';

jest.mock('os', () => ({ homedir: jest.fn() }));
jest.mock('fs', () => ({
  promises: { stat: jest.fn() },
}));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn() }));

const homedirMock = os.homedir as jest.MockedFunction<typeof os.homedir>;
const statMock = fs.stat as jest.MockedFunction<typeof fs.stat>;
const loadItemMock = loadItem as jest.MockedFunction<typeof loadItem>;

describe('resolveCodexModelCatalogPath', () => {
  const previousCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    homedirMock.mockReturnValue('C:\\Users\\test');
    statMock.mockReset();
    loadItemMock.mockReset();
    delete process.env.CODEX_HOME;
  });

  afterAll(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  it('defaults to off and does not inspect the cache', async () => {
    loadItemMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>);

    await expect(resolveCodexModelCatalogPath()).resolves.toBeUndefined();
    expect(statMock).not.toHaveBeenCalled();
  });

  it('uses the default Codex cache when the experiment is enabled', async () => {
    loadItemMock.mockResolvedValue({ experimental: { enabled: false, codexModelCatalogCache: true } });
    statMock.mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>);

    await expect(resolveCodexModelCatalogPath()).resolves.toBe(
      path.join('C:\\Users\\test', '.codex', 'models_cache.json'),
    );
  });

  it('respects CODEX_HOME', async () => {
    loadItemMock.mockResolvedValue({ experimental: { enabled: false, codexModelCatalogCache: true } });
    process.env.CODEX_HOME = 'D:\\codex-state';
    statMock.mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>);

    await expect(resolveCodexModelCatalogPath()).resolves.toBe(
      path.join('D:\\codex-state', 'models_cache.json'),
    );
  });

  it('returns undefined when no cache exists', async () => {
    loadItemMock.mockResolvedValue({ experimental: { enabled: false, codexModelCatalogCache: true } });
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    await expect(resolveCodexModelCatalogPath()).resolves.toBeUndefined();
  });

  it('defaults to off when settings cannot be read', async () => {
    loadItemMock.mockRejectedValue(new Error('storage unavailable'));

    await expect(resolveCodexModelCatalogPath()).resolves.toBeUndefined();
    expect(statMock).not.toHaveBeenCalled();
  });
});
