/**
 * Package-registry account service (issue #197): token encrypt→store→load→decrypt
 * round-trip, masking on `getAccountStatus`, publish error mapping, and the
 * silent refresh-on-401 path. The storage, encryption, and HTTP-client
 * boundaries are all mocked; the service logic runs for real.
 */
import { StorageKey } from '@/shared/types/storage';
import { MASKED_API_KEY } from '@/shared/types/constants';

// In-memory storage keyed by StorageKey.
const store = new Map<StorageKey, unknown>();
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(async (key: StorageKey, value: unknown) => {
    store.set(key, value);
  }),
  loadItem: jest.fn(async (key: StorageKey, def: unknown) => (store.has(key) ? store.get(key) : def)),
}));

// Reversible encryption stub mirroring the `encrypted:` envelope semantics.
jest.mock('@/backend/services/model/encryption', () => ({
  encryptApiKey: jest.fn(async (v: string) => (v ? `enc:${v}` : '')),
  decryptApiKey: jest.fn(async (v: string) => (v?.startsWith('enc:') ? v.slice(4) : v)),
}));

const signupMock = jest.fn();
const loginMock = jest.fn();
const refreshMock = jest.fn();
const resendMock = jest.fn();
const publishPackageMock = jest.fn();
const requestPasswordResetMock = jest.fn();
jest.mock('@/backend/utils/packageRegistryClient', () => ({
  signup: (...a: unknown[]) => signupMock(...a),
  login: (...a: unknown[]) => loginMock(...a),
  refresh: (...a: unknown[]) => refreshMock(...a),
  resendConfirmation: (...a: unknown[]) => resendMock(...a),
  publishPackage: (...a: unknown[]) => publishPackageMock(...a),
  requestPasswordReset: (...a: unknown[]) => requestPasswordResetMock(...a),
}));

import {
  authenticate,
  getAccountStatus,
  logout,
  publish,
  requestPasswordReset,
} from '@/backend/services/registry';

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
});

describe('authenticate + token storage (#197)', () => {
  it('stores encrypted tokens on login and masks them on status', async () => {
    loginMock.mockResolvedValue({
      status: 200,
      body: {
        access_token: 'access-123',
        refresh_token: 'refresh-456',
        publisher_handle: 'mario',
        is_confirmed: true,
        expires_in: 3600,
      },
    });

    const result = await authenticate('me@example.com', 'pw', 'login');
    expect(result.status).toBe('authenticated');

    // Tokens are stored ENCRYPTED (never plaintext).
    const stored = store.get(StorageKey.REGISTRY_ACCOUNT) as { accessToken: string; refreshToken: string };
    expect(stored.accessToken).toBe('enc:access-123');
    expect(stored.refreshToken).toBe('enc:refresh-456');

    // Status is masked and leaks no plaintext token.
    const status = await getAccountStatus();
    expect(status.signedIn).toBe(true);
    expect(status.hasToken).toBe(true);
    expect(status.token).toBe(MASKED_API_KEY);
    expect(status.publisherHandle).toBe('mario');
    expect(JSON.stringify(status)).not.toContain('access-123');
  });

  it('reports confirmation_required for a signup with no session and stores no token', async () => {
    signupMock.mockResolvedValue({ status: 200, body: { needs_confirmation: true, email: 'new@example.com' } });

    const result = await authenticate('new@example.com', 'pw', 'signup');
    expect(result.status).toBe('confirmation_required');

    const status = await getAccountStatus();
    expect(status.hasToken).toBe(false);
    expect(status.token).toBe('');
    expect(status.email).toBe('new@example.com');
  });

  it('maps a transport failure (status 0) to an error result', async () => {
    loginMock.mockResolvedValue({ status: 0, body: { message: 'unreachable' } });
    const result = await authenticate('me@example.com', 'pw', 'login');
    expect(result.status).toBe('error');
  });

  it('logout clears the stored tokens', async () => {
    loginMock.mockResolvedValue({ status: 200, body: { access_token: 'a', refresh_token: 'r', is_confirmed: true } });
    await authenticate('me@example.com', 'pw', 'login');
    await logout();
    const status = await getAccountStatus();
    expect(status.signedIn).toBe(false);
    expect(status.hasToken).toBe(false);
  });
});

describe('publish (#197)', () => {
  async function signIn() {
    loginMock.mockResolvedValue({ status: 200, body: { access_token: 'access-1', refresh_token: 'refresh-1', is_confirmed: true } });
    await authenticate('me@example.com', 'pw', 'login');
    loginMock.mockReset();
  }

  it('returns not_authenticated when no token is stored', async () => {
    const result = await publish({ id: 'p' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_authenticated');
    expect(publishPackageMock).not.toHaveBeenCalled();
  });

  it('publishes with the decrypted access token and returns the public url', async () => {
    await signIn();
    publishPackageMock.mockResolvedValue({ status: 201, body: { id: 'pkg1', name: 'my-pkg', version: '1.0.0', url: 'https://r/pkg1' } });

    const result = await publish({ id: 'pkg1' });
    expect(result).toEqual({ ok: true, id: 'pkg1', name: 'my-pkg', version: '1.0.0', url: 'https://r/pkg1' });
    // The client is called with the DECRYPTED token, not the stored ciphertext.
    expect(publishPackageMock).toHaveBeenCalledWith({ id: 'pkg1' }, 'access-1');
  });

  it('silently refreshes on a 401 and retries once', async () => {
    await signIn();
    publishPackageMock
      .mockResolvedValueOnce({ status: 401, body: {} })
      .mockResolvedValueOnce({ status: 201, body: { id: 'pkg1', url: 'https://r/pkg1' } });
    refreshMock.mockResolvedValue({ status: 200, body: { access_token: 'access-2', refresh_token: 'refresh-2', is_confirmed: true } });

    const result = await publish({ id: 'pkg1' });
    expect(result.ok).toBe(true);
    expect(refreshMock).toHaveBeenCalledWith('refresh-1');
    // Retry used the refreshed token.
    expect(publishPackageMock).toHaveBeenLastCalledWith({ id: 'pkg1' }, 'access-2');
    // Rotated tokens are persisted (encrypted).
    const stored = store.get(StorageKey.REGISTRY_ACCOUNT) as { accessToken: string };
    expect(stored.accessToken).toBe('enc:access-2');
  });

  it('clears the session when refresh also fails on 401', async () => {
    await signIn();
    publishPackageMock.mockResolvedValue({ status: 401, body: {} });
    refreshMock.mockResolvedValue({ status: 401, body: {} });

    const result = await publish({ id: 'pkg1' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unauthorized');
    const status = await getAccountStatus();
    expect(status.signedIn).toBe(false);
  });

  it.each([
    [403, 'unconfirmed'],
    [409, 'name_collision'],
    [400, 'validation'],
    [422, 'validation'],
  ])('maps publish status %s to code %s', async (httpStatus, code) => {
    await signIn();
    publishPackageMock.mockResolvedValue({ status: httpStatus, body: { message: 'x' } });
    const result = await publish({ id: 'pkg1' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(code);
  });
});

describe('requestPasswordReset (#206)', () => {
  it('returns success on a 2xx and forwards the trimmed email to the client', async () => {
    requestPasswordResetMock.mockResolvedValue({ status: 200, body: {} });
    const result = await requestPasswordReset('  me@example.com  ');
    expect(result).toEqual({ success: true });
    expect(requestPasswordResetMock).toHaveBeenCalledWith('me@example.com');
  });

  it('rejects an empty email without calling the client', async () => {
    const result = await requestPasswordReset('   ');
    expect(result.success).toBe(false);
    expect(requestPasswordResetMock).not.toHaveBeenCalled();
  });

  it('maps a transport failure (status 0) to a failure result', async () => {
    requestPasswordResetMock.mockResolvedValue({ status: 0, body: { message: 'unreachable' } });
    const result = await requestPasswordReset('me@example.com');
    expect(result.success).toBe(false);
    expect(result.message).toBeDefined();
  });

  it("surfaces the registry's friendly error message on a non-2xx", async () => {
    requestPasswordResetMock.mockResolvedValue({ status: 429, body: { error: 'Too many requests' } });
    const result = await requestPasswordReset('me@example.com');
    expect(result.success).toBe(false);
    expect(result.message).toBe('Too many requests');
  });

  it('never returns/leaks the plaintext email in the result', async () => {
    requestPasswordResetMock.mockResolvedValue({ status: 200, body: {} });
    const result = await requestPasswordReset('secret@example.com');
    expect(JSON.stringify(result)).not.toContain('secret@example.com');
  });
});
