import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import DayView from '@/frontend/components/Waves/DayView';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { LOCALE_STORAGE_KEY } from '@/frontend/i18n/locales';
import type { AutomationMapResponse } from '@/shared/types/waves/automationMap';

const day = new Date(2026, 9, 10, 12);
const data: AutomationMapResponse = {
  paused: false, generatedAt: day.toISOString(),
  packages: [{ name: 'Work', flowIds: ['flow'], executionIds: ['run', 'check'] }],
  flows: [{
    flow: { id: 'flow', name: 'Daily work', nodes: [], edges: [] },
    packageNames: ['Work'], executionIds: ['run', 'check'], waveIds: [], componentIds: [],
  }],
  executions: [
    {
      executionId: 'run', name: 'Morning report', flowId: 'flow', enabled: true,
      packageNames: ['Work'], trigger: { type: 'schedule', cron: '0 12 * * *' },
      triggerKind: 'schedule', status: { armed: true, running: false },
      lastRun: null, isRoot: true, waveIds: [],
    },
    {
      executionId: 'check', name: 'Check inbox', flowId: 'flow', enabled: true,
      packageNames: ['Work'], trigger: { type: 'url-watch', cron: '0 13 * * *' },
      triggerKind: 'url-watch', status: { armed: true, running: false },
      lastRun: null, isRoot: true, waveIds: [],
    },
  ],
  relations: [], waves: [], components: [], orphanExecutionIds: [],
};

function renderCalendar(mobile: boolean, onSelectExecution = jest.fn()) {
  const theme = createTheme({
    components: {
      MuiUseMediaQuery: {
        defaultProps: {
          matchMedia: (query: string) => ({
            matches: mobile, media: query, onchange: null,
            addListener: jest.fn(), removeListener: jest.fn(),
            addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn(),
          }),
        },
      },
    },
  });
  return render(
    <ThemeProvider theme={theme}>
      <I18nProvider>
        <DayView data={data} now={day.getTime()} onSelectExecution={onSelectExecution} />
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(() => window.localStorage.removeItem(LOCALE_STORAGE_KEY));

it.each([
  ['en', 'Run', 'Check'],
  ['es', 'Ejecución', 'Comprobación'],
])('names desktop events in %s and keeps their existing action', (locale, runLabel, checkLabel) => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const onSelectExecution = jest.fn();
  renderCalendar(false, onSelectExecution);
  const report = screen.getByRole('button', { name: new RegExp(`, Morning report, ${runLabel}$`) });
  expect(screen.getByRole('button', { name: new RegExp(`, Check inbox, ${checkLabel}$`) })).toBeInTheDocument();
  fireEvent.click(report);
  expect(onSelectExecution).toHaveBeenCalledWith('run');
});

it('announces the phone filter state and restores the events when enabled again', () => {
  renderCalendar(true);
  const chooseDate = screen.getByRole('button', { name: 'Choose date' });
  const phoneControls = within(chooseDate.closest('.MuiPaper-root')! as HTMLElement);
  const work = phoneControls.getByRole('button', { name: 'Work', pressed: true });
  expect(screen.getByRole('button', { name: /Morning report/ })).toBeInTheDocument();
  fireEvent.click(work);
  expect(work).toHaveAttribute('aria-pressed', 'false');
  expect(screen.queryByRole('button', { name: /Morning report/ })).not.toBeInTheDocument();
  expect(screen.getByText('Nothing scheduled for this day.')).toBeInTheDocument();
  fireEvent.click(work);
  expect(work).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /Morning report/ })).toBeInTheDocument();
});

it('announces whether the phone calendar is expanded through closing and selection', () => {
  renderCalendar(true);
  const chooseDate = screen.getByRole('button', { name: 'Choose date', expanded: false });
  fireEvent.click(chooseDate);
  expect(chooseDate).toHaveAccessibleName('Hide month');
  expect(chooseDate).toHaveAttribute('aria-expanded', 'true');
  const panel = document.getElementById(chooseDate.getAttribute('aria-controls')!);
  expect(panel).not.toBeNull();
  fireEvent.click(chooseDate);
  expect(chooseDate).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(chooseDate);
  const selected = within(document.getElementById(chooseDate.getAttribute('aria-controls')!)!)
    .getByRole('button', { name: 'Sunday, October 11, 2026' });
  fireEvent.click(selected);
  expect(chooseDate).toHaveAttribute('aria-expanded', 'false');
  expect(chooseDate).toHaveAccessibleName('Choose date');
  expect(chooseDate).toHaveFocus();
});
