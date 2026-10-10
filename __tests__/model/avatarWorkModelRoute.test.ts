jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/backend/services/model', () => ({ modelService: { getModel: jest.fn(), testModel: jest.fn() } }));
jest.mock('@/backend/services/avatar/workModel', () => ({ selectVerifiedAvatarWorkModel: jest.fn() }));
import { POST } from '@/app/api/avatar/work-model/route';
import { modelService } from '@/backend/services/model';
import { selectVerifiedAvatarWorkModel } from '@/backend/services/avatar/workModel';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextResponse } from 'next/server';
const request = () => new Request('http://localhost/api/avatar/work-model', { method: 'POST', body: JSON.stringify({ modelId: 'm' }) });
describe('avatar work readiness gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(assertUnlocked).mockResolvedValue(null);
    jest.mocked(modelService.getModel).mockResolvedValue({ id: 'm', name: 'sonnet', ApiKey: 'secret' });
  });
  it('refuses to mark a transport-only success ready', async () => {
    jest.mocked(modelService.testModel).mockResolvedValue({ ok: true, tool: { ok: false } } as never);
    expect(await (await POST(request())).json()).toMatchObject({ ready: false });
    expect(selectVerifiedAvatarWorkModel).not.toHaveBeenCalled();
  });
  it('only saves a preference after the real tool roundtrip passes', async () => {
    jest.mocked(modelService.testModel).mockResolvedValue({ ok: true, tool: { ok: true } } as never);
    expect(await (await POST(request())).json()).toMatchObject({ ready: true });
    expect(selectVerifiedAvatarWorkModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'm' }));
  });
  it('does not attribute a concurrent edit to the previously tested connection', async () => {
    jest.mocked(modelService.getModel).mockResolvedValueOnce({ id: 'm', name: 'sonnet', ApiKey: 'secret' }).mockResolvedValueOnce({ id: 'm', name: 'opus', ApiKey: 'secret' });
    jest.mocked(modelService.testModel).mockResolvedValue({ ok: true, tool: { ok: true } } as never);
    expect((await POST(request())).status).toBe(409);
    expect(selectVerifiedAvatarWorkModel).not.toHaveBeenCalled();
  });
  it('keeps locked workspaces from invoking a provider', async () => {
    jest.mocked(assertUnlocked).mockResolvedValue(new NextResponse('Locked', { status: 423 }));
    expect((await POST(request())).status).toBe(423);
    expect(modelService.testModel).not.toHaveBeenCalled();
  });
});
