/** Real MCP persistence and crypto, confined to jest.setup.ts's temporary data root. */
import { readFile } from 'fs/promises';
import path from 'path';
import type { EnvVarValue, MCPServerConfig } from '@/shared/types/mcp';
import { MASKED_API_KEY, MASKED_STRING } from '@/shared/types/constants';
import { StorageKey } from '@/shared/types/storage';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { getWorkspaceDataDir } from '@/utils/workspace';

jest.mock('@/backend/services/model/encryption', () => {
  const actual = jest.requireActual('@/backend/services/model/encryption');
  return { ...actual, encryptApiKey: jest.fn(actual.encryptApiKey) };
});

import { MCPService } from '@/backend/services/mcp';
import { encryptApiKey, decryptApiKey } from '@/backend/services/model/encryption';

jest.setTimeout(60000);
const secret = (value: string): EnvVarValue => ({ value, metadata: { isSecret: true } });
const plaintext = 'synthetic-github-credential-for-storage-test';
const encryptedMock = jest.mocked(encryptApiKey);
let service: MCPService;

async function stored(): Promise<Record<string, MCPServerConfig>> {
  return loadItem(StorageKey.MCP_SERVERS, {});
}

beforeEach(async () => {
  encryptedMock.mockReset().mockImplementation(
    jest.requireActual<typeof import('@/backend/services/model/encryption')>('@/backend/services/model/encryption').encryptApiKey,
  );
  await saveItem(StorageKey.MCP_SERVERS, {});
  service = new MCPService();
});

async function create(env: Record<string, EnvVarValue>) {
  return service.updateServerConfig('github-test', {
    name: 'github-test', transport: 'stdio', command: 'node', args: [], disabled: true, env,
  });
}

it('encrypts installer-style wrapped env in the actual saved file and decrypts it for runtime use', async () => {
  await create({ GITHUB_TOKEN: secret(plaintext), MCP_IDLE_TIMEOUT_MS: '0' });
  const env = (await stored())['github-test'].env;
  expect(env.MCP_IDLE_TIMEOUT_MS).toBe('0');
  expect(env.GITHUB_TOKEN).toEqual({ value: expect.stringMatching(/^encrypted:/), metadata: { isSecret: true } });
  const value = (env.GITHUB_TOKEN as { value: string }).value;
  expect(value).not.toContain(plaintext);
  await expect(decryptApiKey(value)).resolves.toBe(plaintext);
  const disk = await readFile(path.join(getWorkspaceDataDir(), 'db', 'mcp_servers.json'), 'utf8');
  expect(disk).not.toContain(plaintext);
  expect(disk).not.toContain('encrypted_failed:');
});

it('infers legacy secret names while respecting explicitly nonsecret fields and global bindings', async () => {
  await create({
    GITHUB_TOKEN: plaintext,
    TOKEN_LABEL: { value: 'public-label', metadata: { isSecret: false } },
    BOUND: secret('${global:GITHUB_TOKEN}'),
    EMPTY: secret(''),
  });
  const env = (await stored())['github-test'].env;
  expect(env.GITHUB_TOKEN).toEqual({ value: expect.stringMatching(/^encrypted:/), metadata: { isSecret: true } });
  expect(env.TOKEN_LABEL).toEqual({ value: 'public-label', metadata: { isSecret: false } });
  expect(env.BOUND).toEqual(secret('${global:GITHUB_TOKEN}'));
  expect(env.EMPTY).toEqual(secret(''));
  expect(encryptedMock).toHaveBeenCalledTimes(1);
});

it.each([MASKED_STRING, MASKED_API_KEY])('retains the stored secret for UI mask %s while editing another env value', async (mask) => {
  await create({ GITHUB_TOKEN: secret(plaintext), COUNT: '0' });
  const previous = (await stored())['github-test'].env.GITHUB_TOKEN;
  encryptedMock.mockClear();
  await service.updateServerConfig('github-test', { env: { GITHUB_TOKEN: secret(mask), COUNT: '1' } });
  expect((await stored())['github-test'].env).toEqual({ GITHUB_TOKEN: previous, COUNT: '1' });
  expect(encryptedMock).not.toHaveBeenCalled();
});

it('inherits a custom env secret flag for raw-string updates and masks, unless explicitly turned off', async () => {
  await create({ CUSTOM_CRED: secret(plaintext) });
  await service.updateServerConfig('github-test', { env: { CUSTOM_CRED: 'synthetic-rotated-value' } });
  const previous = (await stored())['github-test'].env.CUSTOM_CRED;
  expect(previous).toEqual({ value: expect.stringMatching(/^encrypted:/), metadata: { isSecret: true } });
  await expect(decryptApiKey((previous as { value: string }).value)).resolves.toBe('synthetic-rotated-value');
  encryptedMock.mockClear();
  await service.updateServerConfig('github-test', { env: { CUSTOM_CRED: MASKED_STRING } });
  expect((await stored())['github-test'].env.CUSTOM_CRED).toEqual(previous);
  expect(encryptedMock).not.toHaveBeenCalled();
  await service.updateServerConfig('github-test', { env: { CUSTOM_CRED: { value: 'public', metadata: { isSecret: false } } } });
  expect((await stored())['github-test'].env.CUSTOM_CRED).toEqual({ value: 'public', metadata: { isSecret: false } });
});

it('does not double-encrypt existing ciphertext, drops orphan masks, and allows explicit deletion', async () => {
  await create({ GITHUB_TOKEN: secret(plaintext) });
  const env = (await stored())['github-test'].env;
  encryptedMock.mockClear();
  await service.updateServerConfig('github-test', { env: { ...env, MISSING_TOKEN: secret(MASKED_STRING) } });
  expect((await stored())['github-test'].env).toEqual(env);
  expect(encryptedMock).not.toHaveBeenCalled();
  await service.updateServerConfig('github-test', { env: {} });
  expect((await stored())['github-test'].env).toEqual({});
});

it.each(['failed-marker', 'plaintext', 'empty', 'throw'])('fails closed without changing persisted config when encryption returns %s', async (failure) => {
  await create({ COUNT: '0' });
  const before = await stored();
  if (failure === 'throw') encryptedMock.mockRejectedValue(new Error(plaintext));
  else encryptedMock.mockResolvedValue(failure === 'failed-marker' ? `encrypted_failed:${plaintext}` : failure === 'empty' ? '' : plaintext);
  const result = await service.updateServerConfig('github-test', { env: { GITHUB_TOKEN: secret(plaintext), COUNT: '1' } });
  expect(result).toEqual({ success: false, error: expect.stringContaining('configuration was not saved') });
  expect(JSON.stringify(result)).not.toContain(plaintext);
  expect(await stored()).toEqual(before);
});

it.each(['env', 'headers', 'oauthClientSecret'])('rejects an incoming failed-encryption marker in %s', async (field) => {
  const value = `encrypted_failed:${plaintext}`;
  const updates = field === 'env' ? { env: { GITHUB_TOKEN: secret(value) } }
    : field === 'headers' ? { headers: { Authorization: secret(value) } }
      : { oauthClientSecret: value };
  const result = await service.updateServerConfig('remote-test', {
    name: 'remote-test', transport: 'streamable', serverUrl: 'https://example.invalid/mcp', disabled: true, env: {}, ...updates,
  });
  expect(result).toEqual({ success: false, error: expect.stringContaining('configuration was not saved') });
  expect(await stored()).toEqual({});
});
