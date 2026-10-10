const assess = jest.fn(), unlocked = jest.fn(), local = jest.fn();
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: () => unlocked() }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: (...args: unknown[]) => local(...args) }));
jest.mock('@/backend/services/mcp/modelRiskAssessment/assessment', () => ({ assessMcpGithubRisk: (...args: unknown[]) => assess(...args) }));
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/mcp/model-risk-assessment/route';
const valid = { repositoryUrl: 'https://github.com/owner/repository', modelId: 'saved-model', includeSource: false };
const request = (value: unknown) => new NextRequest('http://localhost/api/mcp/model-risk-assessment', { method: 'POST', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { jest.clearAllMocks(); unlocked.mockResolvedValue(null); local.mockReturnValue(null); assess.mockResolvedValue({ status: 'assessed', assessment: { score: 40, rationale: 'uncertain', flags: [] } }); });
test('passes only a saved model ID, source choice and genuine request signal with no-store response', async () => {
  const req = request(valid); const response = await POST(req);
  expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(assess).toHaveBeenCalledWith(valid.repositoryUrl, valid.modelId, false, req.signal);
  expect(await response.json()).toMatchObject({ success: true, review: { status: 'assessed' } });
});
test.each([
  { name: 'provider URL override', value: { ...valid, baseUrl: 'https://foreign.invalid' } },
  { name: 'API key', value: { ...valid, apiKey: 'private' } },
  { name: 'missing privacy choice', value: { repositoryUrl: valid.repositoryUrl, modelId: valid.modelId } },
  { name: 'empty model', value: { ...valid, modelId: ' ' } },
  { name: 'nonboolean privacy', value: { ...valid, includeSource: 'false' } },
  { name: 'untrusted GitHub authority', value: { ...valid, repositoryUrl: 'https://github.com@foreign.invalid/owner/repo' } },
  { name: 'arbitrary URL', value: { ...valid, repositoryUrl: 'http://localhost/repo' } },
  { name: 'array', value: [valid] },
])('refuses $name before assessment', async ({ value }) => {
  const response = await POST(request(value)); expect(response.status).toBe(400);
  expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(assess).not.toHaveBeenCalled();
});
test('refuses actual oversized body bytes before model/provider effects', async () => {
  const response = await POST(request({ ...valid, padding: 'x'.repeat(4096) }));
  expect(response.status).toBe(400); expect(assess).not.toHaveBeenCalled();
});
test('preserves origin and encryption admission before assessment', async () => {
  local.mockReturnValue(new Response(null, { status: 403 }));
  expect((await POST(request(valid))).status).toBe(403); expect(unlocked).not.toHaveBeenCalled();
  local.mockReturnValue(null); unlocked.mockResolvedValue(new Response(null, { status: 423 }));
  expect((await POST(request(valid))).status).toBe(423); expect(assess).not.toHaveBeenCalled();
});
