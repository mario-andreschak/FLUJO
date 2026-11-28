/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { LOCALE_STORAGE_KEY, translate, type TranslationKey } from '@/frontend/i18n';

const mockList = jest.fn();
const mockUpdate = jest.fn();

jest.mock('@/frontend/services/plannedExecutions', () => ({
  plannedExecutionsService: {
    list: (...args: unknown[]) => mockList(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    loadRuns: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('@/frontend/components/PlannedExecutions/ExecutionModal', () => ({
  __esModule: true, default: () => null,
}));
jest.mock('@/frontend/hooks/useAutoFocusSearch', () => ({ useAutoFocusSearch: () => null }));
jest.mock('@/frontend/hooks/useListScrollNav', () => ({ useListScrollNav: () => ({ ref: null, clusterProps: {} }) }));
jest.mock('@/frontend/components/shared/ScrollNavCluster', () => ({ __esModule: true, default: () => null }));

import PlannedExecutionsManager from '@/frontend/components/PlannedExecutions';

const t = (key: TranslationKey) => translate('en', key);

const automation = (id: string, name: string, enabled: boolean, folder?: string) => ({
  execution: {
    id,
    name,
    flowId: 'flow',
    enabled,
    ...(folder ? { folder } : {}),
    trigger: { type: 'schedule', cron: '0 9 * * *' },
  },
  status: { running: false, armed: enabled },
  lastRun: null,
});

const mount = () => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  return render(<I18nProvider><PlannedExecutionsManager /></I18nProvider>);
};

beforeEach(() => {
  window.localStorage.clear();
  mockUpdate.mockReset().mockResolvedValue({ success: true });
});
afterEach(() => { window.localStorage.clear(); });

it('turns on the automation whose switch was used', async () => {
  mockList.mockReset().mockResolvedValue({
    paused: false,
    executions: [automation('morning', 'Morning report', true), automation('evening', 'Evening digest', false)],
  });
  mount();

  fireEvent.click(await screen.findByRole('switch', { name: t('automations.card.turnOn') }));

  await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('evening', { enabled: true }));
  expect(mockUpdate).toHaveBeenCalledTimes(1);
});

it('moves the automation whose folder menu was used', async () => {
  mockList.mockReset().mockResolvedValue({
    paused: false,
    executions: [automation('morning', 'Morning report', true, 'Reports')],
  });
  mount();

  fireEvent.click(await screen.findByRole('button', { name: t('automations.card.moveFolderAria') }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reports' }));

  await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('morning', { folder: 'Reports' }));
});
