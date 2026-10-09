import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AllowanceBar, { expandAllowanceIds, groupAllowances } from '@/frontend/components/shared/AllowanceBar';
import { AllowanceProvider } from '@/frontend/contexts/AllowanceContext';
import ModelCard from '@/frontend/components/models/list/ModelCard';
import { modelAllowancePercent, type ModelAllowance, type WorkspaceAllowance } from '@/shared/types/model/allowance';
import { translate } from '@/frontend/i18n/core';
import { WORKSPACE_CHANGED_EVENT } from '@/frontend/utils/workspaceSelection';
import { ENCRYPTION_UNLOCKED_EVENT } from '@/frontend/utils/encryptionLock';
import fs from 'node:fs/promises';
import path from 'node:path';

jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({
  t: (key: never, values?: Record<string, string | number>) => translate('en', key, values),
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en', options).format(value),
}) }));
jest.mock('@/frontend/utils/theme', () => ({ useThemeUtils: () => ({ visualStyle: 'modern' }) }));
jest.mock('@/frontend/components/models/list/ModelTestDialog', () => ({ __esModule: true, default: () => null }));

const now = Date.now();
function row(id = 'one', overrides: Partial<ModelAllowance> = {}): ModelAllowance {
  return { modelId: id, provider: 'codex', accountGroup: 'shared', status: 'available', observedAt: new Date(now).toISOString(), source: 'codex-app-server',
    windows: [{ id: 'short', label: 'Five hours', remainingPercent: 70, resetAt: new Date(now + 60_000).toISOString() },
      { id: 'long', label: 'Weekly', remainingPercent: 30, resetAt: new Date(now + 120_000).toISOString() }], ...overrides };
}
function snapshot(models = [row(), row('two')]): WorkspaceAllowance {
  return { models, observedAt: new Date(now).toISOString(), entities: { flows: { agent: ['one', 'two'] }, personas: { persona: ['one', 'two'] } } };
}
const fetchMock = jest.fn();
const originalFetch = global.fetch;
beforeEach(() => { fetchMock.mockReset(); global.fetch = fetchMock; window.localStorage.clear(); });
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });
const respond = (data: WorkspaceAllowance) => ({ ok: true, json: async () => data });

test('deduplicates shared accounts and chooses most constrained window without averaging', () => {
  const grouped = groupAllowances([row(), row('two'), row('three', { provider: 'claude', accountGroup: 'different', windows: [{ id: 'weekly', label: 'Weekly', remainingPercent: 90, resetAt: null }] })], now);
  expect(grouped).toHaveLength(2);
  expect(grouped.map(modelAllowancePercent)).toEqual([30, 90]);
  expect(grouped[0].windows).toHaveLength(2);
});

test('expired, reset and unknown observations never become zero or full allowance', () => {
  expect(modelAllowancePercent(groupAllowances([row('old', { observedAt: new Date(now - 300_000).toISOString() })], now)[0])).toBeNull();
  expect(modelAllowancePercent(groupAllowances([row('reset', { windows: [{ id: 'short', label: 'Short', remainingPercent: 70, resetAt: new Date(now).toISOString() }] })], now)[0])).toBeNull();
  expect(modelAllowancePercent(groupAllowances([row('unknown', { status: 'unknown', windows: [] })], now)[0])).toBeNull();
});

test('recursive policies preserve primary/fallback order and deduplicate shared references safely', () => {
  const rows = [row('policy', { policyModelIds: ['two', 'nested', 'one'] }), row('nested', { policyModelIds: ['one', 'policy'] }), row(), row('two')];
  expect(expandAllowanceIds(['policy'], rows)).toEqual(['two', 'one']);
  expect(groupAllowances([row(), row('two', { status: 'unknown', windows: [] })], now)[0].status).toBe('unknown');
});

test('unmatched and partly observed models show unknown details without inventing account percent', async () => {
  fetchMock.mockResolvedValue(respond(snapshot([row('one', { provider: 'claude', source: null, status: 'unknown', windows: [] }), row('two', { windows: [{ id: 'unknown', label: 'Unknown window', remainingPercent: null, resetAt: null }] })])));
  render(<AllowanceProvider><AllowanceBar modelIds={['missing', 'one', 'two']} /></AllowanceProvider>);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await screen.findByText('Partial: 1 unknown windows');
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Subscription allowance/ }));
  expect(screen.getByText(/missing · Not observed/)).toBeInTheDocument();
  expect(screen.getByText(/Claude updates during SDK runs/)).toBeInTheDocument();
});

test('one workspace GET serves model, agent, Persona and provider bars; expansion does not fetch', async () => {
  fetchMock.mockResolvedValue(respond(snapshot()));
  render(<AllowanceProvider><AllowanceBar modelIds={['one', 'two']} /><AllowanceBar entity={{ kind: 'flows', id: 'agent' }} /><AllowanceBar entity={{ kind: 'personas', id: 'persona' }} /><AllowanceBar overview /></AllowanceProvider>);
  await waitFor(() => expect(screen.getAllByRole('progressbar')).toHaveLength(4));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getAllByRole('button', { name: /Subscription allowance/ })[0]);
  expect(screen.getByText('Weekly: 30% left', { exact: false })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh observation' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls[1][1].method).toBe('POST');
});

test('aborts old workspace request and refuses its late result', async () => {
  let resolveOld!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(respond(snapshot([row('other', { status: 'unknown', windows: [] })])));
  render(<AllowanceProvider><AllowanceBar overview /></AllowanceProvider>);
  const oldSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  act(() => { window.localStorage.setItem('flujo-ui:workspace', 'second'); window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED_EVENT, { detail: { workspace: 'second' } })); });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => { resolveOld(respond(snapshot())); });
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls[1][0]).toContain('workspace=second');
});

test('unlock retries cached GET after a locked mount, without collecting provider telemetry', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 423 }).mockResolvedValueOnce(respond(snapshot()));
  render(<AllowanceProvider><AllowanceBar overview /></AllowanceProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  act(() => window.dispatchEvent(new Event(ENCRYPTION_UNLOCKED_EVENT)));
  await screen.findByRole('progressbar');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(call => call[1].method)).toEqual(['GET', 'GET']);
});

test('picker allowance expansion is a separate keyboard-focusable action and does not select model', async () => {
  fetchMock.mockResolvedValue(respond(snapshot()));
  const select = jest.fn();
  render(<AllowanceProvider><div onKeyDown={select}><ModelCard model={{ id: 'one', name: 'Fixture', provider: 'codex', ApiKey: '' }} selectable onSelect={select} /></div></AllowanceProvider>);
  await screen.findByRole('progressbar');
  const expand = screen.getByRole('button', { name: /Subscription allowance/ });
  await act(async () => { expand.focus(); await Promise.resolve(); });
  expect(expand).toHaveFocus();
  expect(expand.closest('.MuiCardActionArea-root')).toBeNull();
  await act(async () => {
    fireEvent.keyDown(expand, { key: 'Enter' }); fireEvent.keyUp(expand, { key: 'Enter' });
    fireEvent.keyDown(expand, { key: ' ' }); fireEvent.keyUp(expand, { key: ' ' });
    await Promise.resolve();
  });
  fireEvent.click(expand);
  expect(expand).toHaveAttribute('aria-expanded', 'true');
  expect(select).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('account reset removes the numeric bar without another request', async () => {
  jest.useFakeTimers(); jest.setSystemTime(now);
  fetchMock.mockResolvedValue(respond(snapshot([row('one', { windows: [{ id: 'short', label: 'Short', remainingPercent: 70, resetAt: new Date(now + 1000).toISOString() }] })])));
  render(<AllowanceProvider><AllowanceBar modelIds={['one']} /></AllowanceProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole('progressbar')).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(1002));
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('renders an offline expanded policy fixture with shared, unknown and stale accounts', async () => {
  const models = [row('policy', { policyModelIds: ['one', 'two', 'claude', 'stale'] }), row('one', { modelName: 'Codex primary' }),
    row('two', { modelName: 'Codex fallback' }), row('claude', { modelName: 'Claude fallback', provider: 'claude', accountGroup: 'claude', status: 'unknown', source: null, observedAt: null, windows: [] }),
    row('stale', { modelName: 'Stale account fallback', accountGroup: 'old', observedAt: new Date(now - 300_000).toISOString(), status: 'stale' })];
  fetchMock.mockResolvedValue(respond(snapshot(models)));
  const fixture = render(<AllowanceProvider><main style={{ maxWidth: 800, margin: '32px auto', fontFamily: 'Arial, sans-serif' }}>
    <h1>Offline component fixture — synthetic account windows</h1>
    <p>Expanded fallback policy. No real account data or provider requests.</p>
    <AllowanceBar modelIds={['policy']} />
  </main></AllowanceProvider>);
  await screen.findByRole('progressbar');
  fireEvent.click(screen.getByRole('button', { name: /Subscription allowance/ }));
  expect(screen.getByText(/Codex primary/)).toBeInTheDocument();
  expect(screen.getByText(/Codex fallback/)).toBeInTheDocument();
  expect(screen.getByText(/Claude fallback/)).toBeInTheDocument();
  expect(screen.getByText(/Stale account fallback/)).toBeInTheDocument();
  expect(screen.getAllByText(/Shared account: 2 models/)).toHaveLength(2);
  await waitFor(() => expect(screen.getByText(/Codex primary/).closest('.MuiCollapse-root')).toHaveClass('MuiCollapse-entered'));
  const output = process.env.FLUJO_ALLOWANCE_PREVIEW_HTML;
  if (output) {
    const css = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules).map(rule => rule.cssText)).join('\n');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Offline allowance component fixture</title><style>${css}</style></head><body>${fixture.container.innerHTML}</body></html>`, 'utf8');
  }
});
