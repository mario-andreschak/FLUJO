/**
 * Tests for the default protected-path denylist (issue #260). `getHomeDir()` is
 * mocked to a temp dir so the assertions are host-independent, and the operator
 * override env var is patched + restored per test.
 */
import os from 'os';
import path from 'path';

const loadItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...args),
}));

jest.mock('@/utils/paths', () => {
  const actual = jest.requireActual('@/utils/paths');
  return { ...actual, getHomeDir: jest.fn() };
});

import { getHomeDir } from '@/utils/paths';
import {
  isProtected,
  isProtectedPathsEnabled,
  getProtectedPaths,
  __resetProtectedPathsCache,
  ALLOW_PROTECTED_PATHS_ENV,
} from '@/backend/services/mcp/internal/protectedPaths';

const mockedHome = getHomeDir as jest.Mock;
// Base the fake home under the REAL home (not the OS temp dir or the FLUJO data
// dir, both of which are exempt from the deny layer) so the denylist actually
// applies to it.
const HOME = path.join(os.homedir(), 'flujo-fake-home-unit');

describe('protected-path denylist', () => {
  const prevOverride = process.env[ALLOW_PROTECTED_PATHS_ENV];

  beforeEach(() => {
    mockedHome.mockReturnValue(HOME);
    loadItemMock.mockReset();
    delete process.env[ALLOW_PROTECTED_PATHS_ENV];
    __resetProtectedPathsCache();
  });
  afterEach(() => {
    if (prevOverride === undefined) delete process.env[ALLOW_PROTECTED_PATHS_ENV];
    else process.env[ALLOW_PROTECTED_PATHS_ENV] = prevOverride;
    __resetProtectedPathsCache();
  });

  it('denies the platform Documents dir and a file inside it', () => {
    expect(isProtected(path.join(HOME, 'Documents')).denied).toBe(true);
    expect(isProtected(path.join(HOME, 'Documents', 'secret.txt')).denied).toBe(true);
  });

  it('allows an arbitrary temp dir and the data dir', () => {
    const tmp = path.join(os.tmpdir(), `flujo-arbitrary-${Date.now()}`);
    expect(isProtected(tmp).denied).toBe(false);
  });

  it('denies windows AppData / posix credential stores per platform', () => {
    if (process.platform === 'win32') {
      expect(isProtected(path.join(HOME, 'AppData', 'Roaming')).denied).toBe(true);
    } else {
      expect(isProtected(path.join(HOME, '.ssh', 'id_rsa')).denied).toBe(true);
    }
  });

  (process.platform === 'win32' ? it : it.skip)('is case-insensitive on Windows', () => {
    const lower = path.join(HOME.toLowerCase(), 'appdata');
    expect(isProtected(lower).denied).toBe(true);
  });

  it('disables the layer when FLUJO_ALLOW_PROTECTED_PATHS is set', () => {
    process.env[ALLOW_PROTECTED_PATHS_ENV] = '1';
    __resetProtectedPathsCache();
    expect(getProtectedPaths()).toEqual([]);
    expect(isProtected(path.join(HOME, 'Documents')).denied).toBe(false);
  });

  it('leaves protected paths disabled when the experimental setting is missing', async () => {
    loadItemMock.mockResolvedValue({ speech: { enabled: true } });
    expect(await isProtectedPathsEnabled()).toBe(false);
  });

  it('enables protected paths only when explicitly opted in', async () => {
    loadItemMock.mockResolvedValue({
      experimental: { protectedPathsEnabled: true },
    });
    expect(await isProtectedPathsEnabled()).toBe(true);
  });

  it('keeps the legacy environment override authoritative', async () => {
    process.env[ALLOW_PROTECTED_PATHS_ENV] = '1';
    loadItemMock.mockResolvedValue({
      experimental: { protectedPathsEnabled: true },
    });
    expect(await isProtectedPathsEnabled()).toBe(false);
  });

  it('defaults to disabled when settings storage cannot be read', async () => {
    loadItemMock.mockRejectedValue(new Error('disk unavailable'));
    expect(await isProtectedPathsEnabled()).toBe(false);
  });
});
