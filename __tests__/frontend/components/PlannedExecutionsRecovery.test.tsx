import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PlannedExecutionListEntry } from '@/frontend/services/plannedExecutions';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { LOCALE_STORAGE_KEY, translate, type TranslationKey } from '@/frontend/i18n';

const mockList = jest.fn();
const mockPause = jest.fn();
const mockDelete = jest.fn();

jest.mock('@/frontend/services/plannedExecutions', () => ({
  plannedExecutionsService: {
    list: (...args: unknown[]) => mockList(...args),
    setPaused: (...args: unknown[]) => mockPause(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));
jest.mock('@/frontend/components/PlannedExecutions/ExecutionModal', () => ({
  __esModule: true, default: () => null,
}));
jest.mock('@/frontend/components/PlannedExecutions/ExecutionCard', () => ({
  __esModule: true,
  default: ({ entry, onDelete }: { entry: PlannedExecutionListEntry; onDelete: () => void }) => (
    <article aria-label={entry.execution.name}>
      {entry.execution.name}<button onClick={onDelete}>remove {entry.execution.name}</button>
    </article>
  ),
}));
jest.mock('@/frontend/hooks/useAutoFocusSearch', () => ({ useAutoFocusSearch: () => null }));
jest.mock('@/frontend/hooks/useListScrollNav', () => ({ useListScrollNav: () => ({ ref: null, clusterProps: {} }) }));
jest.mock('@/frontend/components/shared/ScrollNavCluster', () => ({ __esModule: true, default: () => null }));

import PlannedExecutionsManager from '@/frontend/components/PlannedExecutions';

const entry = {
  execution: { id: 'morning', name: 'Morning report', flowId: 'flow', enabled: true, trigger: { type: 'schedule', cron: '0 9 * * *' } },
  status: { running: false, armed: true }, lastRun: null,
};
const saved = { paused: true, executions: [entry] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  window.localStorage.clear();
  mockList.mockReset().mockResolvedValue(saved);
  mockPause.mockReset().mockResolvedValue({ success: true });
  mockDelete.mockReset().mockResolvedValue({ success: true });
});
afterEach(() => { window.localStorage.clear(); jest.useRealTimers(); });

describe.each(['en', 'es'] as const)('schedule recovery in %s', (locale) => {
  const t = (key: TranslationKey) => translate(locale, key);
  const mount = () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    return render(<I18nProvider><PlannedExecutionsManager /></I18nProvider>);
  };

  it('keeps unknown state disabled during loading, distinguishes failure from empty, and retries', async () => {
    const pending = deferred<typeof saved>();
    mockList.mockReturnValueOnce(pending.promise);
    mount();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.queryByText(t('automations.list.active'))).not.toBeInTheDocument();
    await act(async () => pending.resolve({ paused: true, executions: [] }));
    expect(await screen.findByText(t('automations.list.noTriggers'))).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeEnabled();
    mockList.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: t('automations.list.refreshAria') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('automations.list.stale'));
    expect(screen.queryByText(t('automations.list.noTriggers'))).not.toBeInTheDocument();
    mockList.mockResolvedValue(saved);
    fireEvent.click(screen.getByRole('button', { name: t('common.tryAgain') }));
    expect(await screen.findByRole('article', { name: 'Morning report' })).toBeInTheDocument();
    expect(mockList).toHaveBeenLastCalledWith({ throwOnError: true });
  });

  it('shows an initial error without claiming the user has no schedules', async () => {
    mockList.mockRejectedValue(new Error('offline'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(t('automations.list.loadFailed'));
    expect(screen.queryByText(t('automations.list.noTriggers'))).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    mockList.mockResolvedValue(saved);
    fireEvent.click(screen.getByRole('button', { name: t('common.tryAgain') }));
    expect(await screen.findByRole('article')).toBeInTheDocument();
  });

  it('retains schedules, pause state, and search input when polling fails', async () => {
    jest.useFakeTimers();
    mount();
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByPlaceholderText(t('automations.list.search')), { target: { value: 'Morning' } });
    mockList.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(screen.getByRole('article')).toHaveTextContent('Morning report');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByPlaceholderText(t('automations.list.search'))).toHaveValue('Morning');
    expect(screen.getByText(t('automations.list.stale'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('common.tryAgain') }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(t('automations.list.stale'))).not.toBeInTheDocument();
  });

  it('does not display a pause change before confirmation, prevents duplicates, and offers retry', async () => {
    const pending = deferred<{ success: boolean }>();
    mockPause.mockReturnValueOnce(pending.promise).mockResolvedValue({ success: true });
    mount();
    await screen.findByRole('article');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(mockPause).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ success: false }));
    expect(screen.getByText(t('automations.list.pauseFailed'))).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    mockList.mockResolvedValue({ ...saved, paused: false });
    fireEvent.click(screen.getByRole('button', { name: t('common.tryAgain') }));
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
    expect(mockPause).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText(t('automations.list.pauseFailed'))).not.toBeInTheDocument();
  });

  it('keeps failed deletion open, prevents duplicate deletes, and removes the card only after success', async () => {
    const pending = deferred<{ success: boolean }>();
    mockDelete.mockReturnValueOnce(pending.promise).mockResolvedValue({ success: true });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'remove Morning report' }));
    const dialog = screen.getByRole('dialog');
    const deleteButton = within(dialog).getByRole('button', { name: t('automations.list.delete') });
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);
    expect(within(dialog).getByRole('button', { name: t('automations.list.cancel') })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockDelete).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ success: false }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(t('automations.list.deleteFailed'));
    expect(screen.getByRole('article', { hidden: true })).toBeInTheDocument();
    mockList.mockResolvedValue({ paused: true, executions: [] });
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.tryAgain') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(mockDelete).toHaveBeenLastCalledWith('morning');
  });

  it('ignores a list response begun before a successful pause change', async () => {
    mount();
    await screen.findByRole('article');
    const oldRead = deferred<typeof saved>();
    const newRead = deferred<typeof saved>();
    mockList.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    fireEvent.click(screen.getByRole('button', { name: t('automations.list.refreshAria') }));
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(mockPause).toHaveBeenCalledTimes(1));
    await act(async () => oldRead.resolve(saved));
    expect(screen.getByRole('checkbox')).toBeChecked();
    await act(async () => newRead.resolve({ ...saved, paused: false }));
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('recognizes a committed deletion when its response was lost and the next read confirms removal', async () => {
    mockDelete.mockResolvedValue({ success: false, error: 'Network connection lost' });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'remove Morning report' }));
    mockList.mockResolvedValue({ paused: true, executions: [] });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('automations.list.delete') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t('automations.list.noTriggers'))).toBeInTheDocument();
  });

  it('does not restore a deleted schedule from a read started before deletion', async () => {
    mount();
    await screen.findByRole('article');
    const oldRead = deferred<typeof saved>();
    const newRead = deferred<typeof saved>();
    mockList.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    fireEvent.click(screen.getByRole('button', { name: t('automations.list.refreshAria') }));
    fireEvent.click(screen.getByRole('button', { name: 'remove Morning report' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('automations.list.delete') }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
    await act(async () => oldRead.resolve(saved));
    expect(screen.queryByRole('article', { hidden: true })).not.toBeInTheDocument();
    await act(async () => newRead.resolve({ paused: true, executions: [] }));
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
});
