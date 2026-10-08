import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { loadItem } from '@/utils/storage/backend';
import { readStableFile } from '@/utils/readStableFile';
import { prepareCodexModelCatalogSnapshot } from '@/backend/services/model/adapters/codexModelCatalog';

jest.mock('os', () => ({ homedir: jest.fn() }));
jest.mock('fs', () => ({ promises: {
  mkdir: jest.fn(), mkdtemp: jest.fn(), chmod: jest.fn(), writeFile: jest.fn(), rm: jest.fn(),
} }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn() }));
jest.mock('@/utils/readStableFile', () => ({ readStableFile: jest.fn() }));
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => jest.requireActual('path').resolve('fixture-workspace') }));
const warnMock = jest.fn();
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ warn: (...args: unknown[]) => warnMock(...args) }) }));

const homedirMock = os.homedir as jest.MockedFunction<typeof os.homedir>;
const loadItemMock = loadItem as jest.MockedFunction<typeof loadItem>;
const readMock = readStableFile as jest.MockedFunction<typeof readStableFile>;
const mockFs = fs as unknown as Record<'mkdir' | 'mkdtemp' | 'chmod' | 'writeFile' | 'rm', jest.Mock>;
const compatibleCatalog = Buffer.from(' {"client_version":"0.153.0","models":[{"slug":"gpt-5","model_messages":{}}]}\n');
const parent = path.resolve('fixture-workspace', 'db');
const directory = path.join(parent, 'codex-model-catalog-fixture');
const snapshotPath = path.join(directory, 'models_cache.json');

describe('prepareCodexModelCatalogSnapshot', () => {
  const previousCodexHome = process.env.CODEX_HOME;
  beforeEach(() => {
    homedirMock.mockReturnValue('C:\\Users\\test');
    loadItemMock.mockReset().mockResolvedValue({ experimental: { enabled: false, codexModelCatalogCache: true } });
    readMock.mockReset().mockResolvedValue(compatibleCatalog);
    Object.values(mockFs).forEach(mock => mock.mockReset().mockResolvedValue(undefined));
    mockFs.mkdtemp.mockResolvedValue(directory);
    warnMock.mockReset();
    delete process.env.CODEX_HOME;
  });
  afterAll(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  it('defaults to off and does not inspect the cache or create a snapshot', async () => {
    loadItemMock.mockResolvedValue(undefined);
    await expect(prepareCodexModelCatalogSnapshot()).resolves.toBeUndefined();
    expect(readMock).not.toHaveBeenCalled();
    expect(mockFs.mkdir).not.toHaveBeenCalled();
  });

  it('snapshots exact default-home bytes with exclusive creation and owned cleanup', async () => {
    const snapshot = await prepareCodexModelCatalogSnapshot();
    expect(snapshot?.path).toBe(snapshotPath);
    expect(readMock).toHaveBeenNthCalledWith(1, path.join('C:\\Users\\test', '.codex', 'models_cache.json'),
      16 * 1024 * 1024, { allowSymbolicLink: true });
    expect(mockFs.mkdir).toHaveBeenCalledWith(parent, { recursive: true, mode: 0o700 });
    expect(mockFs.mkdtemp).toHaveBeenCalledWith(path.join(parent, 'codex-model-catalog-'));
    expect(mockFs.chmod).toHaveBeenCalledWith(directory, 0o700);
    expect(mockFs.writeFile).toHaveBeenCalledWith(snapshotPath, compatibleCatalog, { flag: 'wx', mode: 0o600 });
    expect(readMock).toHaveBeenNthCalledWith(2, snapshotPath, 16 * 1024 * 1024);
    expect(mockFs.rm).not.toHaveBeenCalled();
    await snapshot?.cleanup();
    expect(mockFs.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  });

  it('respects a trimmed CODEX_HOME and explicitly permits stable source symlinks', async () => {
    process.env.CODEX_HOME = ' D:\\codex-state ';
    await prepareCodexModelCatalogSnapshot();
    expect(readMock).toHaveBeenNthCalledWith(1, path.join('D:\\codex-state', 'models_cache.json'),
      16 * 1024 * 1024, { allowSymbolicLink: true });
  });

  it.each(['missing', 'oversized', 'unstable'])('omits the override for a %s source without creating a snapshot', async reason => {
    readMock.mockRejectedValueOnce(new Error(reason));
    await expect(prepareCodexModelCatalogSnapshot()).resolves.toBeUndefined();
    expect(mockFs.mkdtemp).not.toHaveBeenCalled();
  });

  it.each(['{"client_version":"0.147.0","models":[{"slug":"gpt-5","model_messages":{}}]}',
    '{"client_version":"0.153.0","models":[]}', '{broken-json'])('rejects incompatible or invalid catalog bytes: %s', async bytes => {
    readMock.mockResolvedValueOnce(Buffer.from(bytes));
    await expect(prepareCodexModelCatalogSnapshot()).resolves.toBeUndefined();
    expect(mockFs.mkdtemp).not.toHaveBeenCalled();
  });

  it('defaults to off and preserves the setting-read diagnostic', async () => {
    const err = new Error('storage unavailable');
    loadItemMock.mockRejectedValue(err);
    await expect(prepareCodexModelCatalogSnapshot()).resolves.toBeUndefined();
    expect(readMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith('Failed to read codexModelCatalogCache setting; defaulting to disabled', { err });
  });

  it('rejects a byte-different published copy and removes the unpublished directory', async () => {
    readMock.mockResolvedValueOnce(compatibleCatalog).mockResolvedValueOnce(Buffer.from('different'));
    await expect(prepareCodexModelCatalogSnapshot()).resolves.toBeUndefined();
    expect(mockFs.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  });

  it('cleans up after an exclusive-write refusal without exposing a path', async () => {
    mockFs.writeFile.mockRejectedValue(Object.assign(new Error('already exists'), { code: 'EEXIST' }));
    await expect(prepareCodexModelCatalogSnapshot()).resolves.toBeUndefined();
    expect(readMock).toHaveBeenCalledTimes(1);
    expect(mockFs.rm).toHaveBeenCalledTimes(1);
  });

  it('refuses a pre-cancelled run before inspecting settings or creating files', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareCodexModelCatalogSnapshot(controller.signal)).rejects.toThrow('Codex run cancelled by user.');
    expect(loadItemMock).not.toHaveBeenCalled();
    expect(mockFs.mkdtemp).not.toHaveBeenCalled();
  });

  it('cancellation during source reading is terminal and creates no snapshot', async () => {
    const controller = new AbortController();
    readMock.mockImplementationOnce(async () => { controller.abort(); return compatibleCatalog; });
    await expect(prepareCodexModelCatalogSnapshot(controller.signal)).rejects.toThrow('Codex run cancelled by user.');
    expect(mockFs.mkdtemp).not.toHaveBeenCalled();
  });

  it('cancellation during directory creation removes it before writing catalog bytes', async () => {
    const controller = new AbortController();
    mockFs.mkdtemp.mockImplementationOnce(async () => { controller.abort(); return directory; });
    await expect(prepareCodexModelCatalogSnapshot(controller.signal)).rejects.toThrow('Codex run cancelled by user.');
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(mockFs.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  });

  it('cleans up cancellation during publication and preserves cancellation if cleanup fails', async () => {
    const controller = new AbortController();
    mockFs.writeFile.mockImplementation(async () => { controller.abort(); });
    mockFs.rm.mockRejectedValue(new Error('cleanup details must not escape'));
    await expect(prepareCodexModelCatalogSnapshot(controller.signal)).rejects.toThrow('Codex run cancelled by user.');
    expect(mockFs.rm).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith('Failed to remove Codex model catalog snapshot');
  });

  it('never writes into or recursively removes a directory outside the owned parent', async () => {
    mockFs.mkdtemp.mockResolvedValue(path.resolve('outside', 'codex-model-catalog-fixture'));
    await expect(prepareCodexModelCatalogSnapshot()).resolves.toBeUndefined();
    expect(mockFs.chmod).not.toHaveBeenCalled();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(mockFs.rm).not.toHaveBeenCalled();
  });
});
