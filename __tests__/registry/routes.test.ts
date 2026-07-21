/**
 * REST route tests for the registry account/publish endpoints (issue #197):
 * the localhost / DNS-rebinding guard, body validation, and the publish
 * error-code → HTTP-status mapping. The account service is mocked at the module
 * boundary; each route's own logic runs for real.
 */
import type { NextRequest } from 'next/server';

const authenticateMock = jest.fn();
const getAccountStatusMock = jest.fn();
const logoutMock = jest.fn();
const publishMock = jest.fn();
jest.mock('@/backend/services/registry', () => ({
  authenticate: (...a: unknown[]) => authenticateMock(...a),
  getAccountStatus: (...a: unknown[]) => getAccountStatusMock(...a),
  logout: (...a: unknown[]) => logoutMock(...a),
  publish: (...a: unknown[]) => publishMock(...a),
}));

// Store unlocked (default encryption mode).
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

import { POST as authPost } from '@/app/api/registry/auth/route';
import { POST as publishPost } from '@/app/api/registry/publish/route';

function req(url: string, body: unknown, headers: Record<string, string> = { host: 'localhost:4200' }) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api/registry/auth (#197)', () => {
  it('authenticates a local login request', async () => {
    authenticateMock.mockResolvedValue({ status: 'authenticated', account: { signedIn: true } });
    const res = await authPost(req('http://localhost:4200/api/registry/auth', { action: 'login', email: 'a@b.c', password: 'pw' }));
    expect(res.status).toBe(200);
    expect(authenticateMock).toHaveBeenCalledWith('a@b.c', 'pw', 'login');
  });

  it('rejects a cross-origin (DNS-rebinding) request with 403 and never authenticates', async () => {
    const res = await authPost(
      req('http://localhost:4200/api/registry/auth', { action: 'login', email: 'a@b.c', password: 'pw' }, { host: 'localhost:4200', origin: 'https://evil.example.com' }),
    );
    expect(res.status).toBe(403);
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid action', async () => {
    const res = await authPost(req('http://localhost:4200/api/registry/auth', { action: 'nope', email: 'a@b.c', password: 'pw' }));
    expect(res.status).toBe(400);
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('returns 400 when email or password is missing', async () => {
    const res = await authPost(req('http://localhost:4200/api/registry/auth', { action: 'login', email: '' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/registry/publish (#197)', () => {
  it('returns 400 when no manifest is supplied', async () => {
    const res = await publishPost(req('http://localhost:4200/api/registry/publish', {}));
    expect(res.status).toBe(400);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('returns 200 with the publish result on success', async () => {
    publishMock.mockResolvedValue({ ok: true, id: 'p', url: 'https://r/p' });
    const res = await publishPost(req('http://localhost:4200/api/registry/publish', { manifest: { id: 'p' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: 'p', url: 'https://r/p' });
  });

  it.each([
    ['unconfirmed', 403],
    ['name_collision', 409],
    ['validation', 400],
    ['unauthorized', 401],
    ['not_authenticated', 401],
    ['error', 502],
  ])('maps publish code %s to HTTP %s', async (code, httpStatus) => {
    publishMock.mockResolvedValue({ ok: false, code, error: 'x' });
    const res = await publishPost(req('http://localhost:4200/api/registry/publish', { manifest: { id: 'p' } }));
    expect(res.status).toBe(httpStatus);
  });

  it('rejects a non-local Host with 403', async () => {
    const res = await publishPost(req('http://localhost:4200/api/registry/publish', { manifest: { id: 'p' } }, { host: 'evil.example.com' }));
    expect(res.status).toBe(403);
    expect(publishMock).not.toHaveBeenCalled();
  });
});
