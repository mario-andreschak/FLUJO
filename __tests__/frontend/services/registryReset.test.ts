/** @jest-environment jsdom */
import { registryService } from '@/frontend/services/registry';

const originalFetch = global.fetch;
const fetchMock = jest.fn();
beforeEach(() => { fetchMock.mockReset(); global.fetch = fetchMock; });
afterAll(() => { global.fetch = originalFetch; });

test.each([
  { name: 'accepted request', ok: true, body: { success: true }, expected: true },
  { name: 'refused request', ok: false, body: { success: false, error: 'not found' }, expected: false },
  { name: 'upstream false success on HTTP failure', ok: false, body: { success: true }, expected: false },
  { name: 'missing acknowledgement', ok: true, body: {}, expected: false },
])('reset response: $name', async ({ ok, body, expected }) => {
  fetchMock.mockResolvedValue({ ok, json: async () => body });
  const result = await registryService.requestPasswordReset('new@example.com');
  expect(result.success).toBe(expected);
  expect(fetchMock).toHaveBeenCalledWith('/api/registry/auth/reset', expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'new@example.com' }) }));
});

test('an unreadable reset response cannot claim an email was sent', async () => {
  fetchMock.mockResolvedValue({ ok: false, json: async () => { throw new SyntaxError('not JSON'); } });
  expect((await registryService.requestPasswordReset('new@example.com')).success).toBe(false);
});
