import { flowService } from '@/backend/services/flow';
import { loadConversationState, loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { configuredExecutionAdapter as adapter } from '@/integrations/hackathon-banking/configuredAdapter';
import { authorizeExecutionTransport, registerExecutionExtension, withExecutionExtensionRoute } from '@/backend/execution/extensions';
import { bankingFixture } from './bankingFixture';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/backend/services/flow', () => ({ flowService: { getFlow: jest.fn() } }));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationState: jest.fn(), loadConversationStateReadOnly: jest.fn() }));
jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: jest.fn() }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/services/workspace/workspaceMutationGate', () => ({ withWorkspaceMutation: async (task: () => Promise<unknown>) => task() }));

const conversation = '12345678-1234-4123-8123-123456789abc';
const retiredRoutes = [
  ['/v1/banking/chat', 'POST'],
  [`/v1/banking/conversations/${conversation}`, 'GET'],
  [`/v1/banking/conversations/${conversation}`, 'DELETE'],
  [`/v1/banking/conversations/${conversation}/events`, 'GET'],
  [`/v1/banking/conversations/${conversation}/cancel`, 'POST'],
  ['/v1/banking/unknown', 'POST'],
  ['/v1/banking/unknown', 'GET'],
  ['/v1/banking/session/revoke', 'GET'],
  ['/v1/banking/session/revoke/', 'POST'],
  ['/v1/banking/session/revoke/unknown', 'POST'],
] as const;

describe('retired optional banking namespace', () => {
  let fixture: Awaited<ReturnType<typeof bankingFixture>>;
  let restore: () => void;
  beforeEach(async () => {
    jest.clearAllMocks();
    fixture = await bankingFixture();
    restore = registerExecutionExtension(adapter);
  });
  afterEach(async () => { restore(); await fixture.close(); });

  test.each(retiredRoutes)('%s %s returns 404 before parsing, route tasks or state access', async (path, method) => {
    const request = new Request('http://localhost' + path, { method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid-retired-credential',
        'X-Flujo-User-Assertion': 'invalid-retired-assertion' },
      ...(method === 'POST' ? { body: '{malformed-json' } : {}) });
    const json = jest.spyOn(request, 'json');
    const readBody = request.body && jest.spyOn(request.body, 'getReader');
    const task = jest.fn(async () => Response.json({ unsafe: true }));

    const transport = authorizeExecutionTransport(request);
    expect(transport?.status).toBe(404);
    expect((await withExecutionExtensionRoute(request, task)).status).toBe(404);
    expect(json).not.toHaveBeenCalled();
    if (readBody) expect(readBody).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
    expect(loadConversationState).not.toHaveBeenCalled();
    expect(loadConversationStateReadOnly).not.toHaveBeenCalled();
    expect(flowService.getFlow).not.toHaveBeenCalled();
    expect(runFlow).not.toHaveBeenCalled();
  });

  test('retired chat rejects signed and credential-free requests before parsing', async () => {
    const signed = await fixture.request('A', { message: 'old ingress' }, '/v1/banking/chat');
    const anonymous = new Request('http://localhost/v1/banking/chat', { method: 'POST', body: '{' });
    for (const request of [signed, anonymous]) {
      const readBody = jest.spyOn(request.body!, 'getReader');
      const task = jest.fn(async () => Response.json({ unsafe: true }));
      expect(authorizeExecutionTransport(request)?.status).toBe(404);
      expect((await withExecutionExtensionRoute(request, task)).status).toBe(404);
      expect(readBody).not.toHaveBeenCalled();
      expect(task).not.toHaveBeenCalled();
    }
  });

  test('exact session revoke POST remains admitted to its existing handler', async () => {
    const request = await fixture.request('A', undefined, '/v1/banking/session/revoke');
    const task = jest.fn(async (received: Request) => {
      expect(received).toBe(request);
      return Response.json({ revoked: true });
    });
    expect(authorizeExecutionTransport(request)).toBeNull();
    const response = await withExecutionExtensionRoute(request, task);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect(task).toHaveBeenCalledTimes(1);
    expect(loadConversationState).not.toHaveBeenCalled();
    expect(loadConversationStateReadOnly).not.toHaveBeenCalled();
    expect(flowService.getFlow).not.toHaveBeenCalled();
    expect(runFlow).not.toHaveBeenCalled();
  });
});
