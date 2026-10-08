import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ensureWorkspaceDirs, getCurrentWorkspace } from '@/utils/workspace';
import { PersonaRecoveryError } from '@/backend/services/enduringAgents/personaRecoveryError';

const captureMock = jest.fn();
const planMock = jest.fn();
const restoreMock = jest.fn();
const unlockMock = jest.fn();
const workerMock = jest.fn();
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: () => unlockMock() }));
jest.mock('@/backend/services/workspace/workerMode', () => ({ isWorkerMode: () => workerMock(), assertWorkerRequestReady: () => undefined }));
jest.mock('@/backend/services/enduringAgents/personaRecoveryCapture', () => ({ capturePersonaRecovery: (...args: unknown[]) => captureMock(...args) }));
jest.mock('@/backend/services/enduringAgents/personaRecoveryPlan', () => ({ planPersonaRecoveryRestore: (...args: unknown[]) => planMock(...args) }));
jest.mock('@/backend/services/enduringAgents/personaRecoveryRestore', () => ({ restorePersonaRecovery: (...args: unknown[]) => restoreMock(...args) }));
jest.mock('@/backend/services/enduringAgents/personaRecoveryZip', () => ({ PERSONA_RECOVERY_ZIP_LIMITS: { archiveBytes: 64 } }));

import { POST } from '@/app/api/persona-recovery/route';

function request(action: string, options: { query?: string; headers?: Record<string, string>; body?: Uint8Array; origin?: string } = {}) {
  return new NextRequest(`http://localhost:4285/api/persona-recovery${options.query ?? '?workspace=recovery-route-a&destination=new-workspace'}`, {
    method: 'POST', headers: { host: 'localhost:4285', origin: options.origin ?? 'http://localhost:4285',
      'x-persona-recovery-action': action, ...options.headers }, body: options.body ? new Uint8Array(options.body) : undefined,
  });
}

describe('Persona recovery HTTP boundary', () => {
  beforeEach(async () => {
    jest.clearAllMocks(); unlockMock.mockResolvedValue(undefined); workerMock.mockReturnValue(false);
    await ensureWorkspaceDirs('recovery-route-a'); await ensureWorkspaceDirs('recovery-route-b');
  });

  it('captures the explicitly selected workspace and returns no-store binary bytes with an inspectable summary', async () => {
    captureMock.mockImplementation(async () => ({ bytes: Buffer.from('zip'), manifest: {
      sourceWorkspace: getCurrentWorkspace(), captureId: 'capture-id', capturedAt: 1, counts: { personas: 2 },
    } }));
    const response = await POST(request('capture', { query: '?workspace=recovery-route-b' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('zip');
    expect(JSON.parse(decodeURIComponent(response.headers.get('x-flujo-persona-recovery-summary')!)))
      .toMatchObject({ sourceWorkspace: 'recovery-route-b', archiveBytes: 3, counts: { personas: 2 } });
  });

  it('rejects foreign origins, locked data, workers and implicit/missing workspaces before recovery work', async () => {
    expect((await POST(request('capture', { origin: 'https://external.example' }))).status).toBe(403);
    unlockMock.mockResolvedValueOnce(NextResponse.json({}, { status: 423 }));
    expect((await POST(request('capture'))).status).toBe(423);
    workerMock.mockReturnValueOnce(true);
    expect((await POST(request('capture'))).status).toBe(403);
    expect((await POST(request('capture', { query: '' }))).status).toBe(400);
    expect((await POST(request('capture', { query: '?workspace=does-not-exist' }))).status).toBe(404);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('bounds both declared and streamed uploads, and rejects empty data or invalid destinations', async () => {
    for (const options of [
      { body: new Uint8Array(65) }, { headers: { 'content-length': '65' }, body: new Uint8Array(1) },
      { body: new Uint8Array() }, { headers: { 'content-length': '3' }, body: new Uint8Array(1) },
      { query: '?workspace=recovery-route-a&destination=../bad', body: new Uint8Array(1) },
    ]) expect((await POST(request('inspect', options))).status).toBe(400);
    expect(planMock).not.toHaveBeenCalled(); expect(restoreMock).not.toHaveBeenCalled();
  });

  it('keeps preview read-only and passes the reviewed archive, destination and token to publication', async () => {
    planMock.mockReturnValue({ preview: { previewToken: 'reviewed' } });
    expect(await (await POST(request('inspect', { body: new Uint8Array([1, 2]) }))).json()).toEqual({ previewToken: 'reviewed' });
    expect(restoreMock).not.toHaveBeenCalled();
    restoreMock.mockResolvedValue({ workspace: 'new-workspace', status: 'restored' });
    const response = await POST(request('restore', { body: new Uint8Array([1, 2]), headers: { 'x-persona-recovery-preview': 'reviewed' } }));
    expect(response.status).toBe(200);
    expect(restoreMock).toHaveBeenCalledWith(Buffer.from([1, 2]), 'new-workspace', 'reviewed', expect.objectContaining({ signal: expect.anything() }));
  });

  it('returns actionable validation errors without exposing unexpected storage errors', async () => {
    planMock.mockImplementationOnce(() => { throw new PersonaRecoveryError('Recovery manifest does not match its complete contents.'); });
    let response = await POST(request('inspect', { body: new Uint8Array([1]) }));
    expect(response.status).toBe(400); expect((await response.json()).error).toContain('manifest');
    planMock.mockImplementationOnce(() => { throw new ZodError([]); });
    response = await POST(request('inspect', { body: new Uint8Array([1]) }));
    expect(response.status).toBe(400); expect((await response.json()).error).toContain('unsupported records');
    captureMock.mockRejectedValueOnce(new Error('EACCES C:/private/account-name/data'));
    response = await POST(request('capture'));
    expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain('private');
  });
});
