import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AllowanceBar, { expandAllowanceIds, groupAllowances } from '@/frontend/components/shared/AllowanceBar';
import { AllowanceProvider, ALLOWANCE_REREAD_INTERVAL_MS } from '@/frontend/contexts/AllowanceContext';
import ModelCard from '@/frontend/components/models/list/ModelCard';
import { modelAllowancePercent, type ModelAllowance, type WorkspaceAllowance } from '@/shared/types/model/allowance';
import { translate } from '@/frontend/i18n/core';
import { WORKSPACE_CHANGED_EVENT } from '@/frontend/utils/workspaceSelection';
import { ENCRYPTION_UNLOCKED_EVENT } from '@/frontend/utils/encryptionLock';
import { getModelService } from '@/frontend/services/model';
import type { Model } from '@/shared/types';
import fs from 'node:fs/promises';
import path from 'node:path';

jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({
  t: (key: never, values?: Record<string, string | number>) => translate('en', key, values),
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en', options).format(value),
  formatDate: (value: string, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', options).format(new Date(value)), locale: 'en',
}) }));
jest.mock('@/frontend/utils/theme', () => ({ useThemeUtils: () => ({ visualStyle: 'modern' }) }));
jest.mock('@/frontend/components/models/list/ModelTestDialog', () => ({ __esModule: true, default: () => null }));

const now = Date.now();
/** The backend schedules a usage-permission recheck six hours out. */
const permissionRecheck = () => new Date(now + 6 * 60 * 60 * 1000).toISOString();
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

test.each(['codex', 'claude'] as const)('saving the first %s subscription reveals its allowance without a page reload', async provider => {
  const model: Model = { id: 'first', name: 'first', provider: provider === 'claude' ? 'claude-subscription' : 'codex', adapter: provider === 'claude' ? 'claude-cli' : 'codex-cli', ApiKey: '' };
  const first = row('first', provider === 'claude' ? { provider, status: 'unknown', reason: 'usage-permission', retryAt: permissionRecheck(), observedAt: null, windows: [] } : {});
  let saved = false;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/model/allowance')) return respond(snapshot(saved ? [first] : []));
    saved = true;
    return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => model };
  });
  render(<AllowanceProvider><AllowanceBar overview /></AllowanceProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.queryByText('Subscription allowance')).not.toBeInTheDocument();
  await act(async () => { expect((await getModelService().addModel(model)).success).toBe(true); });
  await screen.findByText('Subscription allowance');
  if (provider === 'codex') expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
  else expect(screen.getByText('Usage not exposed')).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(call => call[0].startsWith('/api/model/allowance')).map(call => call[1].method)).toEqual(['GET', 'GET']);
});

test.each(['update', 'delete'] as const)('%s of the last subscription removes the previous account reading', async mutation => {
  const model: Model = { id: 'one', name: 'one', provider: 'codex', adapter: 'codex-cli', ApiKey: '' };
  let present = true;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.startsWith('/api/model/allowance')) return respond(snapshot(present ? [row()] : []));
    if (options?.method === 'PUT' || options?.method === 'DELETE') present = false;
    return { ok: true, status: options?.method === 'DELETE' ? 204 : 200,
      headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => model };
  });
  render(<AllowanceProvider><AllowanceBar overview /></AllowanceProvider>);
  await screen.findByRole('progressbar');
  await act(async () => {
    const service = getModelService();
    const result = mutation === 'update' ? await service.updateModel({ ...model, ApiKey: 'fixture-api-billing' }) : await service.deleteModel('one');
    expect(result.success).toBe(true);
  });
  await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
  expect(fetchMock.mock.calls.filter(call => call[0].startsWith('/api/model/allowance')).map(call => call[1].method)).toEqual(['GET', 'GET']);
});

test('failed model save retains the existing reading without another usage request', async () => {
  fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/model/allowance') ? respond(snapshot([row()]))
    : { ok: false, status: 409, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => ({ error: 'MODEL_CATALOG_BUSY' }) });
  render(<AllowanceProvider><AllowanceBar overview /></AllowanceProvider>);
  await screen.findByRole('progressbar');
  await act(async () => { expect((await getModelService().addModel({ id: 'new', name: 'new', provider: 'codex', ApiKey: '' })).success).toBe(false); });
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
  expect(fetchMock.mock.calls.filter(call => call[0].startsWith('/api/model/allowance'))).toHaveLength(1);
});

test('saving another shared model preserves the in-flight account collection', async () => {
  let finishCollection!: (value: unknown) => void;
  let collectionSignal: AbortSignal | undefined;
  let collected = false;
  fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
    if (url.startsWith('/api/model/allowance')) {
      if (options.method === 'POST') {
        collectionSignal = options.signal as AbortSignal;
        return new Promise(resolve => { finishCollection = resolve; });
      }
      return respond(snapshot(collected ? [row(), row('two')] : [row('one', { status: 'unknown', observedAt: null, windows: [] })]));
    }
    return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ id: 'two', name: 'two', provider: 'codex', adapter: 'codex-cli', ApiKey: '' }) };
  });
  render(<AllowanceProvider><AllowanceBar overview /></AllowanceProvider>);
  await waitFor(() => expect(collectionSignal).toBeDefined());
  const originalCollectionSignal = collectionSignal;
  await act(async () => { expect((await getModelService().addModel({ id: 'two', name: 'two', provider: 'codex', ApiKey: '' })).success).toBe(true); });
  expect(originalCollectionSignal?.aborted).toBe(false);
  await act(async () => { collected = true; finishCollection(respond(snapshot([row(), row('two')]))); });
  await screen.findByRole('progressbar');
  await waitFor(() => expect(screen.getByText('Shared account: 2 models')).toBeInTheDocument());
  expect(fetchMock.mock.calls.filter(call => call[0].startsWith('/api/model/allowance')).map(call => call[1].method)).toEqual(['GET', 'POST', 'GET']);
});

test('local inference and API billing never acquire subscription meters', async () => {
  fetchMock.mockResolvedValue(respond(snapshot([
    row('local', { provider: 'ollama', billing: 'local', status: 'unavailable', reason: 'unsupported', windows: [] }),
    row('gateway', { provider: 'openrouter', billing: 'api', status: 'unavailable', reason: 'unsupported', windows: [] }),
    row('api-claude', { provider: 'anthropic', billing: 'api', status: 'unavailable', reason: 'unsupported', windows: [] }),
  ])));
  render(<AllowanceProvider><AllowanceBar overview /><AllowanceBar modelIds={['local']} /><AllowanceBar modelIds={['gateway']} /></AllowanceProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.queryByText('Subscription allowance')).not.toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a throttled reading shows its retry time and disables refresh without fabricating a balance', async () => {
  fetchMock.mockResolvedValue(respond(snapshot([row('paused', { provider: 'claude', billing: 'subscription', status: 'unknown', reason: 'rate-limited', retryAt: new Date(Date.now() + 2245_000).toISOString(), observedAt: null, windows: [] })])));
  render(<AllowanceProvider><AllowanceBar modelIds={['paused']} /></AllowanceProvider>);
  await screen.findByText('Usage check paused');
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View Claude usage' })).toHaveAttribute('href', 'https://claude.ai/settings/usage');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('one cached observer catches new run observations while the display is open', async () => {
  jest.useFakeTimers(); jest.setSystemTime(now);
  fetchMock.mockResolvedValueOnce(respond(snapshot([row('claude', { provider: 'claude', reason: 'usage-permission', retryAt: permissionRecheck(), status: 'unknown', observedAt: null, windows: [] })])))
    .mockResolvedValueOnce(respond(snapshot([row('claude', { provider: 'claude', windows: [{ id: 'weekly', label: 'Weekly', remainingPercent: 55, resetAt: null }] })])));
  render(<AllowanceProvider><AllowanceBar modelIds={['claude']} /></AllowanceProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  // A focus right after loading does not re-read (#1278); the slow interval does.
  await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(ALLOWANCE_REREAD_INTERVAL_MS); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '55');
  expect(fetchMock.mock.calls.map(call => call[1].method)).toEqual(['GET', 'GET']);
  // The silent background re-read never replaced the bar with "Checking…".
  expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
});

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

test('partly observed and denied accounts never invent a numeric summary', async () => {
  fetchMock.mockResolvedValue(respond(snapshot([row('one', { provider: 'claude', reason: 'usage-permission', retryAt: permissionRecheck(), source: null, status: 'unknown', windows: [] }), row('two', { windows: [{ id: 'unknown', label: 'Unknown window', remainingPercent: null, resetAt: null }] })])));
  render(<AllowanceProvider><AllowanceBar modelIds={['missing', 'one', 'two']} /></AllowanceProvider>);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await screen.findByText('Partial reading');
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: /Subscription allowance/ })[0]);
  expect(screen.getByText(/Your Claude setup-token can run models/)).toBeInTheDocument();
  expect(screen.getByText(/missing · Connection not found/)).toBeInTheDocument();
});

test('one workspace GET serves model, agent, Persona and provider bars; expansion does not fetch', async () => {
  fetchMock.mockResolvedValue(respond(snapshot()));
  render(<AllowanceProvider><AllowanceBar modelIds={['one', 'two']} /><AllowanceBar entity={{ kind: 'flows', id: 'agent' }} /><AllowanceBar entity={{ kind: 'personas', id: 'persona' }} /><AllowanceBar overview /></AllowanceProvider>);
  await waitFor(() => expect(screen.getAllByRole('progressbar')).toHaveLength(4));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getAllByRole('button', { name: /Subscription allowance/ })[0]);
  expect(screen.getByText('Weekly', { exact: true })).toBeInTheDocument();
  expect(screen.getByText('Weekly', { exact: true }).closest('.MuiStack-root')).toHaveTextContent('30% left');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getAllByRole('button', { name: 'Refresh' })[0]);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls[1][1].method).toBe('POST');
});

test('aborts old workspace request and refuses its late result', async () => {
  let resolveOld!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(respond(snapshot([row('other', { provider: 'claude', status: 'unknown', reason: 'usage-permission', retryAt: permissionRecheck(), windows: [] })])));
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

test('account reset invalidates the bar and triggers a usage check without inventing a full reset', async () => {
  jest.useFakeTimers(); jest.setSystemTime(now);
  fetchMock.mockResolvedValue(respond(snapshot([row('one', { windows: [{ id: 'short', label: 'Short', remainingPercent: 70, resetAt: new Date(now + 1000).toISOString() }] })])));
  render(<AllowanceProvider><AllowanceBar modelIds={['one']} /></AllowanceProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole('progressbar')).toBeInTheDocument();
  await act(async () => { jest.advanceTimersByTime(1002); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(call => call[1].method === 'POST')).toBe(true);
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
  fireEvent.click(screen.getAllByRole('button', { name: /Subscription allowance/ })[0]);
  expect(screen.getByText(/Codex primary/)).toBeInTheDocument();
  expect(screen.getByText(/Codex fallback/)).toBeInTheDocument();
  expect(screen.getByText(/Claude fallback/)).toBeInTheDocument();
  expect(screen.getByText(/Stale account fallback/)).toBeInTheDocument();
  expect(screen.getByText(/Separate accounts are alternatives/)).toBeInTheDocument();
  expect(screen.getAllByText(/Shared account: 2 models/)).toHaveLength(1);
  await waitFor(() => expect(screen.getByText(/Codex primary/).closest('.MuiCollapse-root')).toHaveClass('MuiCollapse-entered'));
  const output = process.env.FLUJO_ALLOWANCE_PREVIEW_HTML;
  if (output) {
    const css = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules).map(rule => rule.cssText)).join('\n');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Offline allowance component fixture</title><style>${css}</style></head><body>${fixture.container.innerHTML}</body></html>`, 'utf8');
  }
});

test('a page overview of many subscriptions shows four compact accounts until expanded (#1278)', async () => {
  const accounts = Array.from({ length: 7 }, (_, index) => row(`account-${index}`, { accountGroup: `group-${index}` }));
  fetchMock.mockResolvedValue(respond(snapshot(accounts)));
  render(<AllowanceProvider><AllowanceBar overview /></AllowanceProvider>);
  await screen.findByText('Subscription allowance');
  await waitFor(() => expect(screen.getAllByRole('progressbar')).toHaveLength(4));
  fireEvent.click(screen.getByRole('button', { name: 'Show all 7 accounts' }));
  expect(screen.getAllByRole('progressbar')).toHaveLength(7);
  fireEvent.click(screen.getByRole('button', { name: 'Show fewer accounts' }));
  expect(screen.getAllByRole('progressbar')).toHaveLength(4);
});

test('a usage-permission refusal keeps Refresh available and is not shown as a provider pause', async () => {
  fetchMock.mockResolvedValue(respond(snapshot([row('claude', { provider: 'claude', reason: 'usage-permission', retryAt: permissionRecheck(), status: 'unknown', observedAt: null, windows: [] })])));
  render(<AllowanceProvider><AllowanceBar modelIds={['claude']} /></AllowanceProvider>);
  await screen.findByText('Usage not exposed');
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  expect(screen.queryByText(/Try again/)).not.toBeInTheDocument();
});
