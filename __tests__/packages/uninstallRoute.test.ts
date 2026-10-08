/**
 * REST route tests for POST /api/packages/uninstall and GET /api/packages/installed
 * (issue #211): the localhost / DNS-rebinding guard, body validation, the 404 for
 * an unknown package, and the happy-path delegation to the orchestrator. The
 * orchestrator is mocked at the module boundary; the route's own logic runs for real.
 */
import type { NextRequest } from 'next/server';

const uninstallPackageMock = jest.fn();
const listInstalledPackagesMock = jest.fn();
const inspectPackageUninstallMock = jest.fn();
jest.mock('@/backend/services/packages/installPackage', () => ({
  uninstallPackage: (...a: unknown[]) => uninstallPackageMock(...a),
  listInstalledPackages: (...a: unknown[]) => listInstalledPackagesMock(...a),
  inspectPackageUninstall: (...a: unknown[]) => inspectPackageUninstallMock(...a),
}));

// The store is unlocked in these tests (default encryption mode).
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

import { POST } from '@/app/api/packages/uninstall/route';
import { GET as installedGet } from '@/app/api/packages/installed/route';

const summary = { packageName: 'my-pkg', ok: true, hasErrors: false, removed: [], skipped: [], errors: [] };
const previousExposureMode = process.env.FLUJO_EXPOSURE_MODE;

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
  process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  uninstallPackageMock.mockResolvedValue(summary);
  inspectPackageUninstallMock.mockResolvedValue({ exists: true, requiresPersonaControl: false });
  listInstalledPackagesMock.mockResolvedValue([{ packageName: 'my-pkg', version: '1.0.0', installedAt: 'now', entityCounts: { flows: 0, models: 0, servers: 0, plannedExecutions: 0 } }]);
});

afterAll(() => {
  if (previousExposureMode === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
  else process.env.FLUJO_EXPOSURE_MODE = previousExposureMode;
});

describe('POST /api/packages/uninstall', () => {
  it('uninstalls a package on a local request and returns the summary', async () => {
    const res = await post({ packageName: 'my-pkg' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    expect(uninstallPackageMock).toHaveBeenCalledWith('my-pkg', {
      allowPersonaPlannedExecutions: false,
    });
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
    inspectPackageUninstallMock.mockResolvedValue({ exists: false, requiresPersonaControl: false });
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

  it('denies Persona-aware uninstall while the app is publicly exposed', async () => {
    process.env.FLUJO_EXPOSURE_MODE = 'public';
    inspectPackageUninstallMock.mockResolvedValue({ exists: true, requiresPersonaControl: true });

    const res = await post(
      { packageName: 'my-pkg' },
      { host: 'flujo.example.com' },
    );

    expect(res.status).toBe(403);
    expect(uninstallPackageMock).not.toHaveBeenCalled();
  });

  it('keeps legacy package uninstall available in public mode', async () => {
    process.env.FLUJO_EXPOSURE_MODE = 'public';

    const res = await post(
      { packageName: 'my-pkg' },
      { host: 'flujo.example.com' },
    );

    expect(res.status).toBe(200);
    expect(uninstallPackageMock).toHaveBeenCalledWith('my-pkg', {
      allowPersonaPlannedExecutions: false,
    });
  });

  it('authorizes Persona-aware uninstall from strict loopback only', async () => {
    inspectPackageUninstallMock.mockResolvedValue({ exists: true, requiresPersonaControl: true });

    const res = await post({ packageName: 'my-pkg' });

    expect(res.status).toBe(200);
    expect(uninstallPackageMock).toHaveBeenCalledWith('my-pkg', {
      allowPersonaPlannedExecutions: true,
    });
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
