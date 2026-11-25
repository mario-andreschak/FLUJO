/**
 * "Anna is editing" leases in the browser (#575). With multi-user mode off
 * an open editor makes no edit-lock or history request at all.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { useEditLease } from '@/frontend/hooks/useEditLease';
import { getEditBase, resetMultiUserModeCache } from '@/frontend/services/sharedItems';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const previousFetch = global.fetch;
let fetchMock: jest.Mock;
const urls = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url)}`);

beforeEach(() => {
  resetMultiUserModeCache();
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = previousFetch;
});

it('asks nothing beyond the mode while multi-user mode is off', async () => {
  fetchMock.mockResolvedValue(jsonResponse({ mode: 'off', user: null }));
  const { result, unmount } = renderHook(() => useEditLease('model', 'm1', true));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await new Promise(resolve => setTimeout(resolve, 20));
  unmount();
  expect(result.current.enabled).toBe(false);
  expect(urls()).toEqual(['GET /api/accounts/session']);
  expect(urls().some(url => url.includes('/api/edit-locks') || url.includes('/api/history'))).toBe(false);
  expect(getEditBase('model', 'm1')).toBeNull();
});

it('opens a lease, shows who else is editing, and lets go on close', async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/accounts/session') return jsonResponse({ mode: 'on', user: { id: 'u_anna' } });
    if (url === '/api/edit-locks' && init?.method === 'POST') {
      return jsonResponse({ enabled: true, revision: 'habc', others: [{ name: 'Ben', since: 1 }], renewInMs: 20_000 });
    }
    return jsonResponse({ enabled: true, released: true });
  });
  const { result, unmount } = renderHook(() => useEditLease('model', 'm1', true));
  await waitFor(() => expect(result.current.enabled).toBe(true));
  expect(result.current.others).toEqual([{ name: 'Ben', since: 1 }]);
  // The model editor's save will name the version it opened.
  expect(getEditBase('model', 'm1')).toBe('habc');
  expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({ kind: 'model', id: 'm1' });

  unmount();
  expect(urls()).toContain('DELETE /api/edit-locks?kind=model&id=m1');
  expect(getEditBase('model', 'm1')).toBeNull();
});

it('shows nothing for a viewer, who may not take a lease', async () => {
  fetchMock.mockImplementation(async (url: string) => (url === '/api/accounts/session'
    ? jsonResponse({ mode: 'on', user: { id: 'u_cleo' } })
    : jsonResponse({ code: 'TEAM_VIEW_ONLY' }, 403)));
  const { result, unmount } = renderHook(() => useEditLease('flow', 'f1', true));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  unmount();
  expect(result.current).toEqual({ enabled: false, others: [], revision: null });
  expect(urls().some(url => url.startsWith('DELETE'))).toBe(false);
});

it('stays quiet for an item that is not open', () => {
  const { result } = renderHook(() => useEditLease('flow', null, true));
  expect(result.current.enabled).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});
