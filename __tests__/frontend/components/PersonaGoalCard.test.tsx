/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PersonaWorkItem } from '@/shared/types/enduringAgent';

const controlWorkItemMock = jest.fn();
const updateWorkItemMock = jest.fn();
jest.mock('@/frontend/services/personas', () => ({ personasService: {
  controlWorkItem: (...args: unknown[]) => controlWorkItemMock(...args),
  updateWorkItem: (...args: unknown[]) => updateWorkItemMock(...args),
} }));

import PersonaGoalCard from '@/frontend/components/Personas/PersonaGoalCard';

const item: PersonaWorkItem = {
  schemaVersion: 1, id: 'work_marketing', personaId: 'persona_frederik', title: 'Make FLUJO known',
  status: 'open', priority: 'normal', dependencyIds: [], createdAt: 1, updatedAt: 42,
  nextAction: 'Publish the research-backed launch article.',
  goal: {
    successCriteria: 'Continue growing the audience until stopped', continuationIntervalMs: 60_000,
    maxConsecutiveFailures: 3, maxRoundsPerDay: 100, dailyWindowStartedAt: 1, roundsInWindow: 4,
    state: 'active', rounds: 4, consecutiveFailures: 0, lastProgressAt: 1_000, nextRunAt: 20_000,
    recoveryCount: 1, progressSummary: 'Finished audience research and drafted an article.',
    interventionReason: 'LinkedIn signup requires account verification; publishing on the project site continues.',
  },
};
const mutate = jest.fn(async (action: () => Promise<unknown>) => { await action(); return true; });

beforeEach(() => { jest.clearAllMocks(); controlWorkItemMock.mockResolvedValue({}); updateWorkItemMock.mockResolvedValue({}); });

it('shows ongoing progress, recovery, and a scheduled continuation while an external dependency waits', () => {
  render(<PersonaGoalCard item={item} busy={false} mutate={mutate} />);
  expect(screen.getByText('Ongoing goal')).toBeInTheDocument();
  expect(screen.getByText(item.goal!.progressSummary!)).toBeInTheDocument();
  expect(screen.getByText('Working around a dependency')).toBeInTheDocument();
  expect(screen.getByText(item.goal!.interventionReason!)).toBeInTheDocument();
  expect(screen.getByText(/Next work session:/)).toBeInTheDocument();
  expect(screen.getByText('1 recovery plan(s)')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Continue goal' })).not.toBeInTheDocument();
});

it('offers Pause and Stop while the durable goal is waiting between sessions', async () => {
  render(<PersonaGoalCard item={item} busy={false} mutate={mutate} />);
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(controlWorkItemMock).toHaveBeenCalledWith('persona_frederik', 'work_marketing', 'pause'));
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(controlWorkItemMock).toHaveBeenCalledWith('persona_frederik', 'work_marketing', 'stop'));
});

it('shows a due pending session as current but preserves a future retry time', () => {
  const pending = { ...item, goal: { ...item.goal!, pendingTaskId: item.id, nextRunAt: Date.now() - 120_000 } };
  const view = render(<PersonaGoalCard item={pending} busy={false} mutate={mutate} />);
  expect(screen.getByText('Work session queued or in progress')).toBeInTheDocument();
  expect(screen.queryByText(/Next work session:|Next attempt:/)).not.toBeInTheDocument();

  view.rerender(<PersonaGoalCard item={{ ...pending, goal: { ...pending.goal, nextRunAt: Date.now() + 60_000 } }} busy={false} mutate={mutate} />);
  expect(screen.getByText(/Next attempt:/)).toBeInTheDocument();
  expect(screen.queryByText('Work session queued or in progress')).not.toBeInTheDocument();
});

it('lets the owner remove an exhausted total budget before continuing the existing goal', async () => {
  const limited: PersonaWorkItem = { ...item, status: 'blocked', goal: { ...item.goal!, maxRounds: 4, state: 'needs_input' } };
  render(<PersonaGoalCard item={limited} busy={false} mutate={mutate} />);
  fireEvent.click(screen.getByText('Success criteria and limits'));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum work sessions (optional)' }), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Continue goal' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(updateWorkItemMock).toHaveBeenCalledWith('persona_frederik', 'work_marketing', {
    expectedUpdatedAt: 42,
    goal: { successCriteria: item.goal!.successCriteria, completionPolicy: 'success_criteria', continuationIntervalMs: 60_000, maxRounds: null, maxRoundsPerDay: 100 },
  }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue goal' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Continue goal' }));
  await waitFor(() => expect(controlWorkItemMock).toHaveBeenCalledWith('persona_frederik', 'work_marketing', 'retry'));
});

it('does not overwrite an edited budget with a newer polling snapshot or silently upgrade its revision', async () => {
  const view = render(<PersonaGoalCard item={item} busy={false} mutate={mutate} />);
  fireEvent.click(screen.getByText('Success criteria and limits'));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum work sessions (optional)' }), { target: { value: '50' } });
  view.rerender(<PersonaGoalCard item={{ ...item, updatedAt: 100, goal: { ...item.goal!, maxRounds: 20 } }} busy={false} mutate={mutate} />);
  expect(screen.getByRole('spinbutton', { name: 'Maximum work sessions (optional)' })).toHaveValue(50);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(updateWorkItemMock).toHaveBeenCalledWith('persona_frederik', 'work_marketing', expect.objectContaining({ expectedUpdatedAt: 42 })));
});

it('keeps an indefinite responsibility active when milestones change unless the owner enables automatic completion', async () => {
  const indefinite: PersonaWorkItem = { ...item, goal: { ...item.goal!, completionPolicy: 'until_stopped' } };
  render(<PersonaGoalCard item={indefinite} busy={false} mutate={mutate} />);
  expect(screen.getByText('Continues until stopped')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Success criteria and limits'));
  const completion = screen.getByRole('checkbox', { name: 'Finish automatically when success criteria are met' });
  expect(completion).not.toBeChecked();
  fireEvent.change(screen.getByRole('textbox', { name: 'Success criteria' }), { target: { value: 'Grow the audience and verify each milestone' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(updateWorkItemMock).toHaveBeenLastCalledWith('persona_frederik', 'work_marketing', expect.objectContaining({
    goal: expect.objectContaining({ completionPolicy: 'until_stopped' }),
  })));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
  fireEvent.click(completion);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(updateWorkItemMock).toHaveBeenLastCalledWith('persona_frederik', 'work_marketing', expect.objectContaining({
    goal: expect.objectContaining({ completionPolicy: 'success_criteria' }),
  })));
});
