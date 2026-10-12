import { createHash } from 'node:crypto';
import { StorageKey } from '@/shared/types/storage';
import type { StoredRegistryAccount } from '@/shared/types/registry';

const store = new Map<StorageKey, unknown>();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: StorageKey, fallback: unknown) => structuredClone(store.has(key) ? store.get(key) : fallback)),
  saveItem: jest.fn(async (key: StorageKey, value: unknown) => { store.set(key, structuredClone(value)); }),
}));
const decryptMock = jest.fn(async (value: string) => value.startsWith('fixture:') ? value.slice(8) : '');
jest.mock('@/backend/services/model/encryption', () => ({
  encryptApiKey: async (value: string) => `fixture:${value}`,
  decryptApiKey: (value: string) => decryptMock(value),
}));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => 'registry-destination-fixture' }));

import {
  authenticate, beginOAuth, completeOAuth, deletePublishedPackage,
  getAccountStatus, publish, resendConfirmation, saveSettings,
} from '@/backend/services/registry';
import { searchPackages } from '@/backend/utils/packageRegistryClient';

const A = 'https://registry-a.invalid';
const B = 'https://registry-b.invalid';
const originalFetch = global.fetch;
const originalOverride = process.env.FLUJO_REGISTRY_BASE_URL;
const account: StoredRegistryAccount = {
  email: 'fixture@example.invalid', publisherHandle: 'publisher', isConfirmed: true,
  expiresAt: null, accessToken: 'fixture:access-a', refreshToken: 'fixture:refresh-a',
};
const tokens = { access_token: 'access-a', refresh_token: 'refresh-a', publisher_handle: 'publisher', is_confirmed: true };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.endsWith('/v1/auth/login') || url.endsWith('/v1/auth/oauth/token')) return jsonResponse(tokens);
  if (init?.method === 'DELETE') return new Response(null, { status: 204 });
  return jsonResponse({ id: 'publisher/package' }, 201);
});

beforeEach(() => {
  store.clear();
  store.set(StorageKey.REGISTRY_SETTINGS, { baseUrl: A });
  delete process.env.FLUJO_REGISTRY_BASE_URL;
  decryptMock.mockClear();
  decryptMock.mockImplementation(async value => value.startsWith('fixture:') ? value.slice(8) : '');
  fetchMock.mockClear();
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/v1/auth/login') || String(input).endsWith('/v1/auth/oauth/token')) return jsonResponse(tokens);
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse({ id: 'publisher/package' }, 201);
  });
  global.fetch = fetchMock;
});

afterAll(() => {
  global.fetch = originalFetch;
  if (originalOverride === undefined) delete process.env.FLUJO_REGISTRY_BASE_URL;
  else process.env.FLUJO_REGISTRY_BASE_URL = originalOverride;
});

async function signIn() {
  expect((await authenticate(account.email, 'synthetic-password', 'login')).status).toBe('authenticated');
  fetchMock.mockClear();
  decryptMock.mockClear();
}

describe('registry issuer destination binding', () => {
  it('keeps same-issuer publication, deletion and masked account status usable', async () => {
    await signIn();
    expect(store.get(StorageKey.REGISTRY_ACCOUNT)).toMatchObject({ registryBaseUrl: A, accessToken: 'fixture:access-a' });
    expect(await publish({ id: 'publisher/package' })).toMatchObject({ ok: true });
    expect(await deletePublishedPackage('publisher/package')).toEqual({ ok: true });
    expect(await getAccountStatus()).toMatchObject({ signedIn: true, hasToken: true, token: '********' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${A}/v1/packages`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer access-a' }), redirect: 'error',
    }));
  });

  it.each([B, `${A}/different`, 'http://registry-a.invalid'])('refuses saved credentials after selecting %s', async selected => {
    await signIn();
    expect((await saveSettings(selected)).success).toBe(true);
    expect(await publish({ id: 'publisher/package' })).toMatchObject({ ok: false, code: 'not_authenticated' });
    expect(await deletePublishedPackage('publisher/package')).toMatchObject({ ok: false, code: 'not_authenticated' });
    expect(await getAccountStatus()).toMatchObject({ signedIn: false, hasToken: false, token: '', email: null, publisherHandle: null });
    expect(decryptMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an environment override before decrypting saved credentials', async () => {
    await signIn();
    process.env.FLUJO_REGISTRY_BASE_URL = B;
    expect(await publish({ id: 'publisher/package' })).toMatchObject({ code: 'not_authenticated' });
    expect(await getAccountStatus()).toMatchObject({ signedIn: false });
    expect(decryptMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 'file:///tmp/registry', `${A}?route=b`, 'https://user@registry-a.invalid'])('refuses missing or invalid issuer %s without guessing legacy provenance', async issuer => {
    store.set(StorageKey.REGISTRY_ACCOUNT, { ...account, registryBaseUrl: issuer });
    expect(await publish({ id: 'publisher/package' })).toMatchObject({ code: 'not_authenticated' });
    expect(await getAccountStatus()).toMatchObject({ signedIn: false, email: null });
    expect(decryptMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes host case, default port, dot segments and trailing slashes', async () => {
    expect((await saveSettings('HTTPS://REGISTRY-A.INVALID:443/a/../')).success).toBe(true);
    await signIn();
    expect((await saveSettings(`${A}///`)).success).toBe(true);
    expect(await publish({ id: 'publisher/package' })).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`${A}/v1/packages`, expect.anything());
  });

  it('keeps a custom registry path prefix usable', async () => {
    await saveSettings(`${A}/custom`);
    await signIn();
    expect(store.get(StorageKey.REGISTRY_ACCOUNT)).toMatchObject({ registryBaseUrl: `${A}/custom` });
    expect(await publish({ id: 'publisher/package' })).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`${A}/custom/v1/packages`, expect.anything());
  });

  it('requires fresh sign-in before using the newly selected registry', async () => {
    await signIn();
    await saveSettings(B);
    expect(await publish({ id: 'publisher/package' })).toMatchObject({ code: 'not_authenticated' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...tokens, access_token: 'access-b', refresh_token: 'refresh-b' }));
    await signIn();
    expect(await publish({ id: 'publisher/package' })).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`${B}/v1/packages`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer access-b' }),
    }));
  });

  it('keeps an admitted endpoint when the setting changes during decryption', async () => {
    await signIn();
    decryptMock.mockImplementationOnce(async () => { await saveSettings(B); return 'access-a'; });
    expect(await publish({ id: 'publisher/package' })).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`${A}/v1/packages`, expect.anything());
    expect(await getAccountStatus()).toMatchObject({ signedIn: false });
  });

  it('hides account status when selection changes during its decryptability check', async () => {
    await signIn();
    decryptMock.mockImplementationOnce(async () => { await saveSettings(B); return 'access-a'; });
    expect(await getAccountStatus()).toMatchObject({ signedIn: false, email: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])('pins successful 401 refresh, rotation and retry even with destination drift=%s', async drift => {
    await signIn();
    fetchMock.mockImplementationOnce(async () => {
      if (drift) await saveSettings(B);
      return jsonResponse({}, 401);
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...tokens, access_token: 'rotated-a', refresh_token: 'rotated-refresh-a' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'publisher/package' }, 201));
    expect(await publish({ id: 'publisher/package' })).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${A}/v1/auth/refresh`, expect.objectContaining({ body: JSON.stringify({ refresh_token: 'refresh-a' }), redirect: 'error' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, `${A}/v1/packages`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer rotated-a' }) }));
    expect(store.get(StorageKey.REGISTRY_ACCOUNT)).toMatchObject({ registryBaseUrl: A, accessToken: 'fixture:rotated-a' });
    expect((await getAccountStatus()).signedIn).toBe(!drift);
  });

  it('binds delayed login output to the issuer without reporting it as the newly selected account', async () => {
    fetchMock.mockImplementationOnce(async () => { await saveSettings(B); return jsonResponse(tokens); });
    expect(await authenticate(account.email, 'synthetic-password', 'login')).toMatchObject({ status: 'error' });
    expect(store.get(StorageKey.REGISTRY_ACCOUNT)).toMatchObject({ registryBaseUrl: A });
    expect(await getAccountStatus()).toMatchObject({ signedIn: false, email: null });
    fetchMock.mockClear();
    decryptMock.mockClear();
    expect(await publish({ id: 'publisher/package' })).toMatchObject({ code: 'not_authenticated' });
    expect(decryptMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps same-issuer OAuth PKCE and single-use state', async () => {
    const begun = await beginOAuth('github', 'http://localhost/api/registry/oauth/callback');
    await saveSettings('https://REGISTRY-A.invalid:443/');
    expect((await completeOAuth('synthetic-code', begun.state)).status).toBe('authenticated');
    expect(store.get(StorageKey.REGISTRY_ACCOUNT)).toMatchObject({ registryBaseUrl: A, authMethod: 'oauth' });
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected the actual OAuth JSON body.');
    const verifier: unknown = JSON.parse(body).code_verifier;
    if (typeof verifier !== 'string') throw new Error('Expected a string PKCE verifier.');
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(new URL(begun.authorizationUrl).searchParams.get('code_challenge'));
    expect((await completeOAuth('synthetic-code', begun.state)).status).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['setting', 'environment', 'path'])('rejects and consumes changed-destination OAuth state via %s before transmitting secrets', async change => {
    const begun = await beginOAuth('github', 'http://localhost/api/registry/oauth/callback');
    if (change === 'environment') process.env.FLUJO_REGISTRY_BASE_URL = B;
    else await saveSettings(change === 'path' ? `${A}/different` : B);
    expect((await completeOAuth('synthetic-code', begun.state)).status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
    delete process.env.FLUJO_REGISTRY_BASE_URL;
    await saveSettings(A);
    expect((await completeOAuth('synthetic-code', begun.state)).status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pins an admitted OAuth exchange and its acquired tokens across later destination drift', async () => {
    const begun = await beginOAuth('github', 'http://localhost/api/registry/oauth/callback');
    fetchMock.mockImplementationOnce(async () => { await saveSettings(B); return jsonResponse(tokens); });
    expect((await completeOAuth('synthetic-code', begun.state)).status).toBe('error');
    expect(fetchMock).toHaveBeenCalledWith(`${A}/v1/auth/oauth/token`, expect.objectContaining({ redirect: 'error' }));
    expect(store.get(StorageKey.REGISTRY_ACCOUNT)).toMatchObject({ registryBaseUrl: A });
    expect(await getAccountStatus()).toMatchObject({ signedIn: false });
  });

  it('does not forward an old account email automatically to a different registry', async () => {
    await signIn();
    await saveSettings(B);
    expect((await resendConfirmation()).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await resendConfirmation('explicit@example.invalid');
    expect(fetchMock).toHaveBeenCalledWith(`${B}/v1/auth/resend-confirmation`, expect.objectContaining({ body: JSON.stringify({ email: 'explicit@example.invalid' }) }));
  });

  it('keeps confirmation metadata only at its captured registry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ needs_confirmation: true, email: account.email }));
    expect(await authenticate(account.email, 'synthetic-password', 'signup', 'publisher')).toMatchObject({
      status: 'confirmation_required', account: { email: account.email, hasToken: false },
    });
    expect(store.get(StorageKey.REGISTRY_ACCOUNT)).toMatchObject({ registryBaseUrl: A });
    fetchMock.mockClear();
    expect((await resendConfirmation()).success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`${A}/v1/auth/resend-confirmation`, expect.anything());
    await saveSettings(B);
    fetchMock.mockClear();
    expect(await getAccountStatus()).toMatchObject({ email: null });
    expect((await resendConfirmation()).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not carry issuer A linked-provider metadata into a new issuer B account', async () => {
    const begun = await beginOAuth('github', 'http://localhost/api/registry/oauth/callback');
    await completeOAuth('synthetic-code', begun.state);
    expect(await getAccountStatus()).toMatchObject({ linkedProviders: ['github'] });
    await saveSettings(B);
    await signIn();
    expect(await getAccountStatus()).not.toHaveProperty('linkedProviders');
  });

  it('requests redirect refusal for login and maps a rejected redirect to transport failure', async () => {
    fetchMock.mockImplementationOnce(async (_input, init) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError('Synthetic redirect refusal');
    });
    expect(await authenticate(account.email, 'synthetic-password', 'login')).toMatchObject({ status: 'error', message: 'Could not reach the package registry.' });
    expect(store.has(StorageKey.REGISTRY_ACCOUNT)).toBe(false);
  });

  it('preserves anonymous browsing after a registry change', async () => {
    await signIn();
    await saveSettings(B);
    await searchPackages({ q: 'fixture' });
    expect(fetchMock).toHaveBeenCalledWith(`${B}/v1/packages?q=fixture`, expect.objectContaining({ headers: { Accept: 'application/json' } }));
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it.each(['https:registry.invalid', 'file:///tmp/registry', `${A}?secret=q`, `${A}#fragment`, 'https://user:pass@registry-a.invalid'])('rejects an ambiguous or non-HTTP base address %s', async candidate => {
    expect((await saveSettings(candidate)).success).toBe(false);
    expect(store.get(StorageKey.REGISTRY_SETTINGS)).toEqual({ baseUrl: A });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
