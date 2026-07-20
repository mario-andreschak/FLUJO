/**
 * REST route tests for POST /api/packages/install and its status endpoint
 * (issue #198): the localhost / DNS-rebinding guard, body validation, and the
 * happy-path delegation to the orchestrator. The orchestrator is mocked at the
 * module boundary; the route's own logic runs for real.
 */
import type { NextRequest } from 'next/server';

const installPackageMock = jest.fn();
const getLastInstallSummaryMock = jest.fn();
jest.mock('@/backend/services/packages/installPackage', () => ({
  installPackage: (...a: unknown[]) => installPackageMock(...a),
  getLastInstallSummary: (...a: unknown[]) => getLastInstallSummaryMock(...a),
}));

// The store is unlocked in these tests (default encryption mode).
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

import { POST } from '@/app/api/packages/install/route';
import { GET as statusGet } from '@/app/api/packages/install/status/route';

const summary = { ok: true, dryRun: false, created: [], updated: [], skipped: [], disabled: [], servers: [], errors: [] };

const post = (body: unknown, headers: Record<string, string> = { host: 'localhost:4200' }) => {
  const request = new Request('http://localhost:4200/api/packages/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(request);
};

beforeEach(() => {
  jest.clearAllMocks();
  installPackageMock.mockResolvedValue(summary);
});

describe('POST /api/packages/install', () => {
  it('installs a registry package on a local request and returns the summary', async () => {
    const res = await post({ source: 'registry', packageId: 'my-pkg', version: '1.0.0', secrets: { API_KEY: 'sk-1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    expect(installPackageMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'registry', packageId: 'my-pkg', version: '1.0.0', consentGranted: true, secrets: { API_KEY: 'sk-1' } }),
    );
  });

  it('rejects a cross-origin (DNS-rebinding) request with 403 and never installs', async () => {
    const res = await post(
      { source: 'registry', packageId: 'my-pkg' },
      { host: 'localhost:4200', origin: 'https://evil.example.com' },
    );
    expect(res.status).toBe(403);
    expect(installPackageMock).not.toHaveBeenCalled();
  });

  it('rejects a non-local Host with 403', async () => {
    const res = await post({ source: 'registry', packageId: 'my-pkg' }, { host: 'evil.example.com' });
    expect(res.status).toBe(403);
    expect(installPackageMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an unsupported source', async () => {
    const res = await post({ source: 'ftp', packageId: 'my-pkg' });
    expect(res.status).toBe(400);
    expect(installPackageMock).not.toHaveBeenCalled();
  });

  it('returns 400 when packageId is missing', async () => {
    const res = await post({ source: 'registry' });
    expect(res.status).toBe(400);
    expect(installPackageMock).not.toHaveBeenCalled();
  });

  it('returns 400 when a secret value is not a string', async () => {
    const res = await post({ source: 'registry', packageId: 'my-pkg', secrets: { API_KEY: 123 } });
    expect(res.status).toBe(400);
    expect(installPackageMock).not.toHaveBeenCalled();
  });

  it('propagates a non-ok summary as 400', async () => {
    installPackageMock.mockResolvedValue({ ...summary, ok: false, errors: ['bad manifest'] });
    const res = await post({ source: 'registry', packageId: 'my-pkg' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/packages/install/status', () => {
  const statusReq = (query: string, headers: Record<string, string> = { host: 'localhost:4200' }) => {
    const request = new Request(`http://localhost:4200/api/packages/install/status${query}`, {
      method: 'GET',
      headers,
    }) as unknown as NextRequest;
    return statusGet(request);
  };

  it('returns the last summary for a known package', async () => {
    getLastInstallSummaryMock.mockResolvedValue(summary);
    const res = await statusReq('?package=my-pkg');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ package: 'my-pkg', summary });
  });

  it('returns 404 when no install record exists', async () => {
    getLastInstallSummaryMock.mockResolvedValue(null);
    const res = await statusReq('?package=ghost');
    expect(res.status).toBe(404);
  });

  it('returns 400 without a package query param', async () => {
    const res = await statusReq('');
    expect(res.status).toBe(400);
  });

  it('rejects a non-local request with 403', async () => {
    const res = await statusReq('?package=my-pkg', { host: 'evil.example.com' });
    expect(res.status).toBe(403);
  });
});
