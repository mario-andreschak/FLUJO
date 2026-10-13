import { render, screen } from '@testing-library/react';
import FactoryObservatoryPanel from '@/frontend/components/Waves/FactoryObservatoryPanel';

const originalFetch = global.fetch;

afterEach(() => { global.fetch = originalFetch; });

test('shows actual FACTORY cells and marks stale data when refresh fails', async () => {
  const fetcher = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ factoryId: 'world-swarm', observedAt: '2026-10-08T00:00:00.000Z',
      revision: 42, mission: 'Run SAVIA', status: 'active', unresolvedEffects: 0,
      cells: [
        { id: 'root', parentId: null, depth: 0, role: 'coordinator', status: 'ready', purpose: 'Run SAVIA' },
        { id: 'lead', parentId: 'root', depth: 1, role: 'coordinator', status: 'ready', purpose: 'Lead' },
      ], tasks: [{ id: 'case-1', owner: 'lead', status: 'running', projectId: 'savia' }] }) })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'FACTORY_UNAVAILABLE' }) });
  global.fetch = fetcher as typeof fetch;
  render(<FactoryObservatoryPanel />);
  expect(await screen.findByText('Run SAVIA · 2 cells · 1 task · 0 unresolved effects')).toBeInTheDocument();
  expect(screen.getByText('lead')).toBeInTheDocument();
  expect(screen.getByText('1 task')).toBeInTheDocument();
  screen.getByRole('button', { name: 'Refresh' }).click();
  expect(await screen.findByText(/Showing the last received snapshot/)).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledWith('/api/factory-observatory', { cache: 'no-store' });
});
