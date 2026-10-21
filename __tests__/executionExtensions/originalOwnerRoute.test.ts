import { GET, POST } from '@/app/api/original-owner/route';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { listOriginalOwnerRecords } from '@/backend/services/originalOwner/administration';

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn() }));
jest.mock('@/backend/services/security/ownerAccess', () => ({ resolveOwnerRequest: jest.fn() }));
jest.mock('@/backend/services/originalOwner/administration', () => ({
  listOriginalOwnerRecords: jest.fn(), createOriginalOwnerAccount: jest.fn(),
  enrollOriginalOwnerTask: jest.fn(), revokeOriginalOwnerRecord: jest.fn(),
}));

beforeEach(() => { jest.clearAllMocks(); });

it.each([['GET', GET], ['POST', POST]] as const)('refuses %s before reading owner records while encryption is locked', async (_method, handler) => {
  const locked = Response.json({ error: 'Locked' }, { status: 423 });
  jest.mocked(assertUnlocked).mockResolvedValue(locked as never);
  expect(await handler(new Request('http://localhost/api/original-owner'))).toBe(locked);
  expect(resolveOwnerRequest).not.toHaveBeenCalled();
  expect(listOriginalOwnerRecords).not.toHaveBeenCalled();
});

it('still requires owner authorization after encryption is unlocked', async () => {
  jest.mocked(assertUnlocked).mockResolvedValue(null);
  const denied = Response.json({ error: 'Unauthorized' }, { status: 401 });
  jest.mocked(resolveOwnerRequest).mockReturnValue({ ok: false, response: denied } as never);
  expect(await GET(new Request('http://localhost/api/original-owner'))).toBe(denied);
  expect(listOriginalOwnerRecords).not.toHaveBeenCalled();
});
