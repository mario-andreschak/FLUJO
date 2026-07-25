/**
 * REST route tests for POST /api/packages/uninstall and GET /api/packages/installed
 * (issue #211): the localhost / DNS-rebinding guard, body validation, the 404 for
 * an unknown package, and the happy-path delegation to the orchestrator. The
 * orchestrator is mocked at the module boundary; the route's own logic runs for real.
 */
import type { NextRequest } from 'next/server';

const uninstallPackageMock = jest.fn();
const listInstalledPackagesMock = jest.fn();
jest.mock('@/backend/services/packages/installPackage', () => ({
  uninstallPackage: (...a: unknown[]) => uninstallPackageMock(...a),
  listInstalledPackages: (...a: unknown[]) => listInstalledPackagesMock(...a),
}));

// The store is unlocked in these tests (default encryption mode).
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

import { POST } from '@/app/api/packages/uninstall/route';
import { GET as installedGet } from '@/app/api/packages/installed/route';

const summary = { packageName: 'my-pkg', ok: true, hasErrors: false, removed: [], skipped: [], errors: [] };

const post = (body: unknown, headers: Record<string, string> = { host: 'localhost:4200' }) => {
  const request = new Request('http://localhost:4200/api/packages/uninstall', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(request);
};

beforeEach(() => {
  jest.clearAllMocks();
  uninstallPackageMock.mockResolvedValue(summary);
  listInstalledPackagesMock.mockResolvedValue([{ packageName: 'my-pkg', version: '1.0.0', installedAt: 'now', entityCounts: { flows: 0, models: 0, servers: 0, plannedExecutions: 0 } }]);
});

describe('POST /api/packages/uninstall', () => {
  it('uninstalls a package on a local request and returns the summary', async () => {
    const res = await post({ packageName: 'my-pkg' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    expect(uninstallPackageMock).toHaveBeenCalledWith('my-pkg');
  });

  it('rejects a cross-origin (DNS-rebinding) request with 403 and never uninstalls', async () => {
    const res = await post({ packageName: 'my-pkg' }, { host: 'localhost:4200', origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
    expect(uninstallPackageMock).not.toHaveBeenCalled();
  });

  it('rejects a non-local Host with 403', async () => {
    const res = await post({ packageName: 'my-pkg' }, { host: 'evil.example.com' });
    expect(res.status).toBe(403);
    expect(uninstallPackageMock).not.toHaveBeenCalled();
  });

  it('returns 400 when packageName is missing', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(uninstallPackageMock).not.toHaveBeenCalled();
  });

  it('returns 404 for a package with no install record', async () => {
    listInstalledPackagesMock.mockResolvedValue([]);
    const res = await post({ packageName: 'ghost' });
    expect(res.status).toBe(404);
    expect(uninstallPackageMock).not.toHaveBeenCalled();
  });

  it('returns 200 with hasErrors on a partial failure', async () => {
    uninstallPackageMock.mockResolvedValue({ ...summary, ok: false, hasErrors: true, errors: [{ kind: 'model', id: 'm', reason: 'boom' }] });
    const res = await post({ packageName: 'my-pkg' });
    expect(res.status).toBe(200);
    expect((await res.json()).hasErrors).toBe(true);
  });
});

describe('GET /api/packages/installed', () => {
  const get = (headers: Record<string, string> = { host: 'localhost:4200' }) => {
    const request = new Request('http://localhost:4200/api/packages/installed', {
      method: 'GET',
      headers,
    }) as unknown as NextRequest;
    return installedGet(request);
  };

  it('returns the installed-packages list', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).packages).toHaveLength(1);
  });

  it('rejects a non-local request with 403', async () => {
    const res = await get({ host: 'evil.example.com' });
    expect(res.status).toBe(403);
  });
});
