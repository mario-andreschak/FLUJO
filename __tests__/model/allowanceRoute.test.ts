import { NextRequest, NextResponse } from 'next/server';
import { GET, POST } from '@/app/api/model/allowance/route';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { hasExecutionExtensionContext } from '@/backend/execution/extensions';
import { workspaceAllowance, refreshWorkspaceAllowance } from '@/backend/services/model/allowance';

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn() }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: jest.fn() }));
jest.mock('@/backend/execution/extensions', () => ({ hasExecutionExtensionContext: jest.fn() }));
jest.mock('@/backend/services/model/allowance', () => ({ workspaceAllowance: jest.fn(), refreshWorkspaceAllowance: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(assertUnlocked).mockResolvedValue(null);
  jest.mocked(assertLocalRequest).mockReturnValue(null);
  jest.mocked(hasExecutionExtensionContext).mockReturnValue(false);
  jest.mocked(workspaceAllowance).mockResolvedValue({ models: [], observedAt: '2026-10-09T10:00:00Z' });
  jest.mocked(refreshWorkspaceAllowance).mockResolvedValue({ models: [], observedAt: '2026-10-09T10:00:00Z' });
});

test('GET reads cache only and prevents HTTP response caching', async () => {
  const result = await GET(new NextRequest('http://localhost/api/model/allowance'));
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(workspaceAllowance).toHaveBeenCalledTimes(1);
  expect(refreshWorkspaceAllowance).not.toHaveBeenCalled();
});

test('POST supplies request cancellation to the telemetry refresh', async () => {
  const request = new NextRequest('http://localhost/api/model/allowance', { method: 'POST' });
  expect((await POST(request)).status).toBe(200);
  expect(refreshWorkspaceAllowance).toHaveBeenCalledWith(request.signal);
});

test.each([GET, POST])('locked requests never access allowance services', async handler => {
  jest.mocked(assertUnlocked).mockResolvedValue(new NextResponse('{}', { status: 423 }));
  expect((await handler(new NextRequest('http://localhost/api/model/allowance'))).status).toBe(423);
  expect(workspaceAllowance).not.toHaveBeenCalled();
  expect(refreshWorkspaceAllowance).not.toHaveBeenCalled();
});

test('restricted execution transports cannot refresh host account data', async () => {
  jest.mocked(hasExecutionExtensionContext).mockReturnValue(true);
  expect((await POST(new NextRequest('http://localhost/api/model/allowance', { method: 'POST' }))).status).toBe(403);
  expect(refreshWorkspaceAllowance).not.toHaveBeenCalled();
});

test('provider/native diagnostics cannot leak through HTTP errors', async () => {
  jest.mocked(refreshWorkspaceAllowance).mockRejectedValue(new Error('secret@example.com token-value native stderr'));
  const response = await POST(new NextRequest('http://localhost/api/model/allowance', { method: 'POST' }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'allowance_unavailable' });
});
