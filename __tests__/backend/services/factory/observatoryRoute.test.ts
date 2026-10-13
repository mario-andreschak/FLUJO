const localGuard = jest.fn();
const readSnapshot = jest.fn();

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (request: Request, options: unknown) => localGuard(request, options),
}));
jest.mock('@/backend/services/factory/observatorySnapshot', () => ({
  readFactoryObservatorySnapshot: () => readSnapshot(),
}));

import { GET } from '@/app/api/factory-observatory/route';

const request = new Request('http://127.0.0.1/api/factory-observatory', { headers: { host: '127.0.0.1' } });

beforeEach(() => {
  localGuard.mockReset().mockReturnValue(null);
  readSnapshot.mockReset();
});

test('requires strict loopback before reading FACTORY', async () => {
  localGuard.mockReturnValue(new Response('Forbidden', { status: 403 }));
  const response = await GET(request);
  expect(response.status).toBe(403);
  expect(localGuard).toHaveBeenCalledWith(request, { strictLoopback: true });
  expect(readSnapshot).not.toHaveBeenCalled();
});

test('returns explicit unavailable state and never includes the bearer', async () => {
  readSnapshot.mockRejectedValueOnce(new Error('FACTORY_NOT_CONFIGURED'));
  const unavailable = await GET(request);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: 'FACTORY_NOT_CONFIGURED' });
  readSnapshot.mockResolvedValueOnce({ factoryId: 'world-swarm', cells: [{ id: 'root' }], revision: 3 });
  const available = await GET(request);
  expect(available.status).toBe(200);
  expect(available.headers.get('cache-control')).toBe('no-store');
  expect(await available.json()).toEqual({ factoryId: 'world-swarm', cells: [{ id: 'root' }], revision: 3 });
});
