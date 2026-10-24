import { modelService } from '@/frontend/services/model';

const mockFetch = jest.fn(); const previousFetch = global.fetch;
beforeEach(() => {
  mockFetch.mockReset(); global.fetch = mockFetch;
  mockFetch.mockResolvedValue({ ok: true, status: 200,
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : 'unavailable' },
    json: async () => [{ id: 'private', name: 'Still available', ApiKey: '' }],
  });
});
afterEach(() => { global.fetch = previousFetch; });

it('preserves private choices but tells validators that a shared catalogue failure is not deletion', async () => {
  expect(await modelService.loadModelCatalogue()).toMatchObject({ sharedUnavailable: true, models: [{ id: 'private' }] });
  expect(await modelService.tryLoadModels()).toBeNull();
  expect(await modelService.loadModels()).toHaveLength(1);
});

it('requests private scope for editing without invalidating it on a shared-service warning', async () => {
  expect(await modelService.tryLoadModels('private')).toHaveLength(1);
  expect(mockFetch).toHaveBeenCalledWith('/api/model?scope=private', { cache: 'no-store' });
});
