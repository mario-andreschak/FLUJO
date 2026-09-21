import { flowService } from '@/frontend/services/flow';

it('refreshes the gallery after a Persona endpoint creates a Flow outside the browser cache', async () => {
  const previousFetch = global.fetch;
  const original = { id: 'existing-flow', name: 'Existing Flow', nodes: [], edges: [] };
  const created = { id: 'persona-core', name: 'Frederik Core', nodes: [], edges: [] };
  const fetchMock = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => [original] })
    .mockResolvedValueOnce({ ok: true, json: async () => [original, created] });
  global.fetch = fetchMock;
  try {
    expect(await flowService.loadFlows({ refresh: true })).toEqual([original]);
    expect(await flowService.loadFlows()).toEqual([original]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await flowService.loadFlows({ refresh: true })).toEqual([original, created]);
    expect(await flowService.getFlow(created.id)).toEqual(created);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    global.fetch = previousFetch;
  }
});
