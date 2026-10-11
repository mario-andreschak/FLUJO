import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import SchedulePanel from '@/frontend/components/PlannedExecutions/SchedulePanel';
import { plannedExecutionsService } from '@/frontend/services/plannedExecutions';

jest.mock('@/frontend/services/plannedExecutions', () => ({
  plannedExecutionsService: { previewSchedule: jest.fn() },
}));

const previewSchedule = jest.mocked(plannedExecutionsService.previewSchedule);
const unavailable = { valid: false, unavailable: true, error: 'HTTP 503', nextRuns: [] };
const nextRun = '2026-10-12T09:00:00.000Z';

function Editor({ cron = '0 9 * * *', timezone }: { cron?: string; timezone?: string }) {
  const [value, setValue] = useState({ cron, timezone });
  return <SchedulePanel {...value} onChange={setValue} />;
}

const tick = async () => { await act(async () => { await jest.advanceTimersByTimeAsync(300); }); };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.useFakeTimers();
  previewSchedule.mockReset().mockResolvedValue({ valid: true, nextRuns: [nextRun] });
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

it('shows checking during the debounce and hides old next-run times as soon as the time changes', async () => {
  render(<Editor />);
  expect(screen.getByRole('status')).toHaveTextContent('Checking next runs');
  expect(previewSchedule).not.toHaveBeenCalled();
  await tick();
  expect(screen.getByRole('status')).toHaveTextContent('Next:');

  const pending = deferred<{ valid: boolean; nextRuns: string[] }>();
  previewSchedule.mockReturnValueOnce(pending.promise);
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:30' } });
  expect(screen.queryByText(/^Next:/)).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Checking next runs');
  await tick();
  expect(previewSchedule).toHaveBeenLastCalledWith('30 10 * * *', undefined);
  expect(screen.getByRole('status')).toHaveTextContent('Checking next runs');
  await act(async () => { pending.resolve({ valid: true, nextRuns: [nextRun] }); });
  expect(screen.getByRole('status')).toHaveTextContent('Next:');
});

it('keeps the custom pattern and timezone during an unavailable preview and retries those exact inputs', async () => {
  previewSchedule.mockResolvedValueOnce(unavailable);
  render(<Editor cron="0 9 * * 1" timezone="America/Bogota" />);
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
  await tick();

  expect(screen.getByRole('alert')).toHaveTextContent('Could not check the next runs. Your changes are still here.');
  expect(screen.getByRole('alert')).not.toHaveTextContent('not valid');
  expect(screen.queryByText('HTTP 503')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Cron pattern', exact: true })).toHaveValue('0 9 * * 1');
  expect(screen.getByRole('textbox', { name: 'Timezone (optional)' })).toHaveValue('America/Bogota');

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByRole('status')).toHaveTextContent('Checking next runs');
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  await tick();
  expect(previewSchedule).toHaveBeenCalledTimes(2);
  expect(previewSchedule).toHaveBeenLastCalledWith('0 9 * * 1', 'America/Bogota');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Next:');
});

it('discards an earlier response after the timezone changes', async () => {
  const previous = deferred<{ valid: boolean; nextRuns: string[] }>();
  previewSchedule.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(unavailable);
  render(<Editor />);
  await tick();
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Timezone (optional)' }), { target: { value: 'Europe/Berlin' } });
  await tick();
  expect(previewSchedule).toHaveBeenLastCalledWith('0 9 * * *', 'Europe/Berlin');
  expect(screen.getByRole('alert')).toHaveTextContent('Could not check');

  await act(async () => { previous.resolve({ valid: true, nextRuns: [nextRun] }); });
  expect(screen.queryByText(/^Next:/)).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not check');
});

it('reports an invalid schedule with its useful validation detail and no transport retry', async () => {
  previewSchedule.mockResolvedValueOnce({ valid: false, error: 'Invalid timezone: Not/AZone', nextRuns: [] });
  render(<Editor timezone="Not/AZone" />);
  await tick();
  expect(screen.getByRole('alert')).toHaveTextContent('This schedule is not valid.');
  expect(screen.getByRole('alert')).toHaveTextContent('Invalid timezone: Not/AZone');
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
});

it('explains a valid schedule with no upcoming runs', async () => {
  previewSchedule.mockResolvedValueOnce({ valid: true, nextRuns: [] });
  render(<Editor />);
  await tick();
  expect(screen.getByRole('status')).toHaveTextContent('No upcoming runs were found for this schedule.');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('debounces rapid edits and previews only the latest pattern', async () => {
  render(<Editor />);
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:30' } });
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '11:45' } });
  await tick();
  expect(previewSchedule).toHaveBeenCalledTimes(1);
  expect(previewSchedule).toHaveBeenCalledWith('45 11 * * *', undefined);
});

it('cancels the debounce on unmount', async () => {
  const view = render(<Editor />);
  view.unmount();
  await tick();
  expect(previewSchedule).not.toHaveBeenCalled();
});

it('labels separate shared editors without duplicate label IDs', () => {
  render(<><Editor /><Editor /></>);
  const labels = screen.getAllByRole('combobox', { name: 'Runs' }).map((input) => input.getAttribute('aria-labelledby'));
  expect(new Set(labels).size).toBe(2);
  for (const label of labels) expect(document.getElementById(label!)).toHaveTextContent('Runs');
});
