/** Package wizard HTTP boundary: keep workspace selection and access guards real. */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const buildPackageManifestMock = jest.fn();
jest.mock('@/backend/services/packages/buildPackage', () => ({
  buildPackageManifest: (...args: unknown[]) => buildPackageManifestMock(...args),
}));
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

import { POST } from '@/app/api/packages/build/route';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { ensureWorkspaceDirs, getCurrentWorkspace } from '@/utils/workspace';

const assertUnlockedMock = jest.mocked(assertUnlocked);
const selection = { flowIds: ['flow-1'], modelIds: [], mcpServerNames: [], plannedExecutionIds: [] };
const metadata = { id: 'my-package', name: 'My package', version: '1.0.0' };
const result = { ok: true, yaml: 'name: My package', errors: [] };
const originalExposure = Object.fromEntries(
  ['FLUJO_EXPOSURE_MODE', 'FLUJO_EXPOSURE_MODE_SOURCE', 'FLUJO_EXTRA_LOCAL_HOSTS']
    .map(key => [key, process.env[key]]),
);

function request(
  body: unknown,
  { headers = {}, query = '', raw = false }:
    { headers?: Record<string, string>; query?: string; raw?: boolean } = {},
) {
  return new Request(`http://localhost:4200/api/packages/build${query}`, {
    method: 'POST',
    headers: { host: 'localhost:4200', 'content-type': 'application/json', ...headers },
    body: raw ? String(body) : JSON.stringify(body),
  }) as NextRequest;
}

beforeEach(async () => {
  buildPackageManifestMock.mockReset().mockResolvedValue(result);
  assertUnlockedMock.mockReset().mockResolvedValue(null);
  process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  delete process.env.FLUJO_EXPOSURE_MODE_SOURCE;
  delete process.env.FLUJO_EXTRA_LOCAL_HOSTS;
  await ensureWorkspaceDirs('package-builder-tests');
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalExposure)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /api/packages/build', () => {
  it('selects the requested workspace and forwards the reviewed package inputs', async () => {
    let selectedWorkspace: string | undefined;
    buildPackageManifestMock.mockImplementationOnce(async () => {
      selectedWorkspace = getCurrentWorkspace();
      return result;
    });
    const acceptedSecrets = [{ excerpt: 'private-value', suggestedSecretName: 'SERVICE_TOKEN' }];
    const globals = [{ name: 'SERVICE_URL', value: 'https://example.test' }];
    const response = await POST(request(
      { selection, metadata, acceptedSecrets, globals, excludedSecrets: ['TOKEN', 17, null] },
      { query: '?workspace=package-builder-tests' },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(selectedWorkspace).toBe('package-builder-tests');
    expect(buildPackageManifestMock).toHaveBeenCalledTimes(1);
    expect(buildPackageManifestMock).toHaveBeenCalledWith(
      selection, metadata, acceptedSecrets, globals, ['TOKEN'],
    );
  });

  it('uses empty optional review lists when they are absent', async () => {
    const response = await POST(request({ selection, metadata }));
    expect(response.status).toBe(200);
    expect(buildPackageManifestMock).toHaveBeenCalledWith(selection, metadata, [], [], []);
  });

  it('rejects an unknown workspace before checking secrets or building a manifest', async () => {
    const response = await POST(request({ selection, metadata }, { query: '?workspace=missing-package-workspace' }));
    expect(response.status).toBe(404);
    expect(assertUnlockedMock).not.toHaveBeenCalled();
    expect(buildPackageManifestMock).not.toHaveBeenCalled();
  });

  it('returns the encryption lock response without building a manifest', async () => {
    assertUnlockedMock.mockResolvedValueOnce(NextResponse.json({ error: 'Locked' }, { status: 423 }));
    const response = await POST(request({ selection, metadata }));
    expect(response.status).toBe(423);
    expect(buildPackageManifestMock).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { host: 'remote.example.test' },
    { host: 'localhost:4200', origin: 'https://remote.example.test' },
  ])('rejects an untrusted host or origin: %j', async headers => {
    const response = await POST(request({ selection, metadata }, { headers }));
    expect(response.status).toBe(403);
    expect(buildPackageManifestMock).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON before calling the builder', async () => {
    const response = await POST(request('{', { raw: true }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
    expect(buildPackageManifestMock).not.toHaveBeenCalled();
  });

  it.each([
    { metadata },
    { selection },
    { selection, metadata: { ...metadata, version: 1 } },
  ])('rejects incomplete package input: %j', async body => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(buildPackageManifestMock).not.toHaveBeenCalled();
  });

  it('returns builder validation failures as 400', async () => {
    const rejected = { ok: false, errors: ['A local-only MCP server cannot be packaged'] };
    buildPackageManifestMock.mockResolvedValueOnce(rejected);
    const response = await POST(request({ selection, metadata }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(rejected);
  });

  it('returns a controlled failure when the builder throws', async () => {
    buildPackageManifestMock.mockRejectedValueOnce(new Error('Package selection is unavailable'));
    const response = await POST(request({ selection, metadata }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Package selection is unavailable' });
  });
});
