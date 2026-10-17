import path from 'node:path';
import type { Model } from '@/shared/types/model';
import { assertRestrictedCodexProfile } from '@/backend/services/model/adapters/codexRestrictedProfile';
import { codexSessionAccountScope } from '@/backend/services/model/adapters/codexSessionStore';
import { installOriginalNativeProfile, originalNativeAccountAttestation,
  assertOriginalNativeAccount } from '@/backend/services/originalOwner/nativeAccount';
import { AccountSchema, type OriginalOwnerAccount } from '@/backend/services/originalOwner/types';

jest.mock('@/backend/services/model/adapters/codexRestrictedProfile', () => ({ assertRestrictedCodexProfile: jest.fn(async () => 'checked-cli') }));
jest.mock('@/backend/services/model/adapters/codexSessionStore', () => ({ codexSessionAccountScope: jest.fn(async () => 'c'.repeat(64)) }));

const profile = { verifiedCliVersion: '0.157.1' as const, verifiedCliSha256: 'a'.repeat(64),
  verifiedCliPath: path.resolve('private-codex'), verifiedModelCatalogPath: path.resolve('private-catalog'),
  verifiedModelCatalogSha256: 'b'.repeat(64) };
const model = { id: 'native', name: 'gpt-6-luna', adapter: 'codex-cli', provider: 'openai', ApiKey: '' } as Model;
const state = globalThis as typeof globalThis & { __flujoOriginalNativeProfile?: unknown };
beforeEach(() => { delete state.__flujoOriginalNativeProfile; jest.clearAllMocks();
  jest.mocked(codexSessionAccountScope).mockResolvedValue('c'.repeat(64)); });
afterEach(() => { delete state.__flujoOriginalNativeProfile; });

it('requires a trusted exact profile and verifies it before reading the subscription identity', async () => {
  await expect(originalNativeAccountAttestation(model)).rejects.toThrow('not_qualified');
  expect(codexSessionAccountScope).not.toHaveBeenCalled();
  installOriginalNativeProfile(profile);
  await expect(originalNativeAccountAttestation(model)).resolves.toEqual({ nativeProfile: profile,nativeAccountScope: 'c'.repeat(64) });
  expect(assertRestrictedCodexProfile).toHaveBeenCalledWith(profile,'gpt-6-luna');
});
it.each([
  { ...model,name: 'gpt-6-astra' }, { ...model,ApiKey: 'separately-billed-key' },
  { ...model,fallbackPolicy: {} }, { ...model,ownerCredentialBinding: { ownerId: 'owner',credentialId: 'key' } },
])('refuses an unapproved model, API key or fallback route before inspecting credentials', async selected => {
  installOriginalNativeProfile(profile);
  await expect(originalNativeAccountAttestation(selected as Model)).rejects.toThrow('not_qualified');
  expect(codexSessionAccountScope).not.toHaveBeenCalled();
});
it('checks current subscription account identity without rehashing the binary on every assertion', async () => {
  installOriginalNativeProfile(profile);
  const account = { kind: 'codex',credential: '',nativeProfile: profile,nativeAccountScope: 'c'.repeat(64) } as OriginalOwnerAccount;
  await expect(assertOriginalNativeAccount(account,model)).resolves.toBeUndefined();
  expect(assertRestrictedCodexProfile).not.toHaveBeenCalled();
  jest.mocked(codexSessionAccountScope).mockResolvedValue('d'.repeat(64));
  await expect(assertOriginalNativeAccount(account,model)).rejects.toThrow('account_changed');
});
it('pins the configured profile and keeps API credentials out of Native account records', () => {
  installOriginalNativeProfile(profile);
  expect(() => installOriginalNativeProfile({ ...profile,verifiedCliSha256: 'f'.repeat(64) })).toThrow('profile_changed');
  const account = { id: 'account',ownerId: 'owner',modelId: model.id,kind: 'codex',credential: '',
    modelDigest: 'd'.repeat(64),routingHeaders: {},nativeProfile: profile,nativeAccountScope: 'c'.repeat(64),
    state: 'active',approval: { ownerId: 'owner',credentialId: 'admin',policyRevision: 'e'.repeat(64) },createdAt: 1,updatedAt: 1 };
  expect(AccountSchema.safeParse(account).success).toBe(true);
  expect(AccountSchema.safeParse({ ...account,credential: 'forbidden-key' }).success).toBe(false);
  expect(AccountSchema.safeParse({ ...account,routingHeaders: { 'openai-project': 'other' } }).success).toBe(false);
  expect(AccountSchema.safeParse({ ...account,nativeProfile: undefined }).success).toBe(false);
});
