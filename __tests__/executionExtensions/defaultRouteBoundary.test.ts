import { NextRequest } from 'next/server';
import { POST } from '@/app/v1/banking/session/revoke/route';

// Importing the actual route must not load any banking implementation in a
// default build. These factories fail if the old compatibility import returns.
jest.mock('@/backend/services/banking/controllers', () => { throw new Error('default route imported banking compatibility controllers'); });
jest.mock('@/integrations/hackathon-banking/controllers', () => { throw new Error('default route imported banking controllers'); });
jest.mock('@/integrations/hackathon-banking/authority', () => { throw new Error('default route imported banking authority'); });
jest.mock('@/integrations/hackathon-banking/policy', () => { throw new Error('default route imported banking policy'); });
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/backend/services/workspace/layoutReadiness', () => ({ waitForWorkspaceLayoutReady: jest.fn(async () => undefined) }));
jest.mock('@/utils/workspace', () => ({ ...jest.requireActual('@/utils/workspace'),
  workspaceExists: jest.fn(async () => true), ensureWorkspaceDirs: jest.fn(async () => undefined) }));

test('default route is an inactive 404 placeholder independent of banking policy and dependencies', async () => {
  const oldAdapter = process.env.FLUJO_EXECUTION_ADAPTER_MODULE;
  const oldPolicy = process.env.FLUJO_BANKING_CONFIG;
  const oldMode = process.env.FLUJO_WORKER_MODE;
  delete process.env.FLUJO_EXECUTION_ADAPTER_MODULE;
  process.env.FLUJO_BANKING_CONFIG = 'nonexistent-policy-is-not-loaded';
  delete process.env.FLUJO_WORKER_MODE;
  try {
    const response = await POST(new NextRequest('http://localhost/v1/banking/session/revoke', { method: 'POST' }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  } finally {
    if (oldAdapter === undefined) delete process.env.FLUJO_EXECUTION_ADAPTER_MODULE; else process.env.FLUJO_EXECUTION_ADAPTER_MODULE = oldAdapter;
    if (oldPolicy === undefined) delete process.env.FLUJO_BANKING_CONFIG; else process.env.FLUJO_BANKING_CONFIG = oldPolicy;
    if (oldMode === undefined) delete process.env.FLUJO_WORKER_MODE; else process.env.FLUJO_WORKER_MODE = oldMode;
  }
});
