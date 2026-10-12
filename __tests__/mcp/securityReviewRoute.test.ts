const localGate = jest.fn(), lockGate = jest.fn(), review = jest.fn();
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: (...args: unknown[]) => localGate(...args) }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: (...args: unknown[]) => lockGate(...args) }));
jest.mock('@/backend/services/mcp/securityReview/review', () => ({ reviewMcpGithubSource: (...args: unknown[]) => review(...args) }));
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/mcp/security-review/route';
const request = (body: unknown) => new NextRequest('http://localhost/api/mcp/security-review', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => { jest.resetAllMocks(); localGate.mockReturnValue(null); lockGate.mockResolvedValue(null); review.mockResolvedValue({ status: 'reviewed', limitations: [] }); });
it('accepts only explicit repository requests and sends the request abort signal', async () => {
  const response = await POST(request({ repositoryUrl: 'https://github.com/a/b.git/', revision: 'a'.repeat(40) }));
  expect(await response.json()).toEqual({ success: true, review: { status: 'reviewed', limitations: [] } });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(review).toHaveBeenCalledWith('https://github.com/a/b.git/', 'a'.repeat(40), expect.any(AbortSignal));
});
it.each([{}, [], null, { repositoryUrl: 'https://evil.test/a/b' }, { repositoryUrl: 'https://github.com/a/b', approved: true }, { repositoryUrl: 'https://github.com/a/b', revision: 'main' }, { repositoryUrl: 'https://github.com/a/b', extra: 'x'.repeat(5000) }])('rejects invalid or oversized request %j before review', async body => {
  expect((await POST(request(body))).status).toBe(400);
  expect(review).not.toHaveBeenCalled();
});
it.each([403, 423])('returns gate%d before reading request or fetching source', async status => {
  if (status === 403) localGate.mockReturnValue(Response.json({ error: 'forbidden' }, { status }));
  else lockGate.mockResolvedValue(Response.json({ error: 'locked' }, { status }));
  expect((await POST(request({ repositoryUrl: 'https://github.com/a/b' }))).status).toBe(status);
  expect(review).not.toHaveBeenCalled();
});
