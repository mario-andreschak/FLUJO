import { NextRequest } from 'next/server';

const assertLocalRequestMock = jest.fn<Response | null, [Request]>();
const assertUnlockedMock = jest.fn<Promise<Response | null>, []>();
const getServerSkillMock = jest.fn();
const loadVerifiedSkillMock = jest.fn();
const approveMcpSkillMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: () => assertUnlockedMock(),
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (request: Request) => assertLocalRequestMock(request),
}));

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    getServerSkill: (...args: unknown[]) => getServerSkillMock(...args),
    loadVerifiedSkill: (...args: unknown[]) => loadVerifiedSkillMock(...args),
  },
}));

jest.mock('@/backend/services/mcp/skillApprovalRegistry', () => ({
  approveMcpSkill: (...args: unknown[]) => approveMcpSkillMock(...args),
}));

import { POST as approveSkill } from '@/app/api/mcp/servers/[name]/skills/approve/route';
import { POST as loadSkill } from '@/app/api/mcp/servers/[name]/skills/load/route';

function request(path: string): NextRequest {
  return new NextRequest(`https://flujo.example.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://attacker.example',
    },
    body: JSON.stringify({
      conversationId: 'conversation_test',
      uri: 'skill://catalog/code-review/SKILL.md',
    }),
  });
}

function context() {
  return { params: Promise.resolve({ name: 'skills-server' }) };
}

function expectNoProtectedWork(): void {
  expect(assertUnlockedMock).not.toHaveBeenCalled();
  expect(getServerSkillMock).not.toHaveBeenCalled();
  expect(loadVerifiedSkillMock).not.toHaveBeenCalled();
  expect(approveMcpSkillMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  assertLocalRequestMock.mockReturnValue(
    new Response('forbidden', { status: 403 }),
  );
  assertUnlockedMock.mockResolvedValue(null);
});

describe('MCP Skills route local-request boundary', () => {
  it('rejects non-local approval before lock or approval work', async () => {
    const response = await approveSkill(
      request('/api/mcp/servers/skills-server/skills/approve'),
      context(),
    );

    expect(response.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(expect.any(NextRequest));
    expectNoProtectedWork();
  });

  it('rejects non-local loading before lock or service work', async () => {
    const response = await loadSkill(
      request('/api/mcp/servers/skills-server/skills/load'),
      context(),
    );

    expect(response.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(expect.any(NextRequest));
    expectNoProtectedWork();
  });
});
