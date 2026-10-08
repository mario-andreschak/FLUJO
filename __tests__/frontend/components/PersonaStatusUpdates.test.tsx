/** @jest-environment jsdom */

import { act, render, screen } from '@testing-library/react';
import PersonaStatusUpdates from '@/frontend/components/Personas/PersonaStatusUpdates';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { LOCALE_STORAGE_KEY } from '@/frontend/i18n/locales';
import type { Persona, PersonaTaskSummary, PersonaWorkItem } from '@/shared/types/enduringAgent';

const persona: Pick<Persona, 'id' | 'name' | 'lifecycleState'> = { id: 'alex', name: 'Alex', lifecycleState: 'idle' };
const task: PersonaTaskSummary = { id: 'receipt', title: 'Review the receipt', state: 'ready', priority: 'normal', blockerTitles: [], expectedUpdatedAt: 1 };
const goal: PersonaWorkItem = {
  schemaVersion: 1, id: 'goal', personaId: persona.id, title: 'Prepare the launch', status: 'open',
  priority: 'normal', dependencyIds: [], createdAt: 1, updatedAt: 1,
  goal: { state: 'active', successCriteria: 'A reviewed launch plan', continuationIntervalMs: 60_000,
    maxConsecutiveFailures: 3, maxRoundsPerDay: 10, rounds: 1, consecutiveFailures: 0, dailyWindowStartedAt: 1, roundsInWindow: 1 },
};

beforeEach(() => { localStorage.clear(); });

it('announces named Task transitions without taking focus or repeating unchanged snapshots', async () => {
  const props = { persona, tasks: [task], workItems: [], lifecycleLabel: 'Ready' };
  const view = render(<><input aria-label="Draft" /><PersonaStatusUpdates {...props} /></>);
  const status = screen.getByRole('status');
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(status).toHaveAttribute('aria-atomic', 'true');
  expect(status).toBeEmptyDOMElement();
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  draft.focus();
  for (const [state, label] of [['waiting', 'Waiting / queued'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['in_progress', 'In progress'], ['completed', 'Completed']] as const) {
    view.rerender(<><input aria-label="Draft" /><PersonaStatusUpdates {...props} tasks={[{ ...task, state }]} /></>);
    expect(status).toHaveTextContent(`Review the receipt: ${label}`);
    expect(draft).toHaveFocus();
  }
  const updates = jest.fn();
  const observer = new MutationObserver(updates);
  observer.observe(status, { childList: true, characterData: true, subtree: true });
  view.rerender(<><input aria-label="Draft" /><PersonaStatusUpdates {...props} tasks={[{ ...task, state: 'completed', expectedUpdatedAt: 99 }]} /></>);
  await act(async () => { await Promise.resolve(); });
  expect(updates).not.toHaveBeenCalled();
  observer.disconnect();
});

it.each([
  ['paused', 'Goal paused'], ['needs_input', 'Needs your input'],
  ['completed', 'Goal completed'], ['stopped', 'Goal stopped'],
] as const)('announces a goal becoming %s even without a visible Task summary', (state, label) => {
  const props = { persona, tasks: [], workItems: [goal], lifecycleLabel: 'Ready' };
  const view = render(<PersonaStatusUpdates {...props} />);
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
  view.rerender(<PersonaStatusUpdates {...props} workItems={[{ ...goal, goal: { ...goal.goal!, state } }]} />);
  expect(screen.getByRole('status')).toHaveTextContent(`Prepare the launch: ${label}`);
});

it('uses one contextual work message when the Persona lifecycle changes in the same snapshot', () => {
  const props = { persona, tasks: [task], workItems: [], lifecycleLabel: 'Ready' };
  const view = render(<PersonaStatusUpdates {...props} />);
  view.rerender(<PersonaStatusUpdates {...props} persona={{ ...persona, lifecycleState: 'busy' }} lifecycleLabel="Working now" tasks={[{ ...task, state: 'in_progress' }]} />);
  expect(screen.getByRole('status')).toHaveTextContent('Review the receipt: In progress');
  expect(screen.getByRole('status')).not.toHaveTextContent('Alex:');
  view.rerender(<PersonaStatusUpdates {...props} lifecycleLabel="Ready" tasks={[{ ...task, state: 'in_progress' }]} />);
  expect(screen.getByRole('status')).toHaveTextContent('Alex: Ready');
});

it('bounds simultaneous announcements while retaining the additional update count', () => {
  const tasks = Array.from({ length: 5 }, (_, index) => ({ ...task, id: String(index), title: `Task ${index + 1}` }));
  const props = { persona, tasks, workItems: [], lifecycleLabel: 'Ready' };
  const view = render(<PersonaStatusUpdates {...props} />);
  view.rerender(<PersonaStatusUpdates {...props} tasks={tasks.map(item => ({ ...item, state: 'completed' }))} />);
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('Task 1: Completed');
  expect(status).toHaveTextContent('Task 3: Completed');
  expect(status).not.toHaveTextContent('Task 4:');
  expect(status).toHaveTextContent('Additional updated work items: 2');
});

it('emits another DOM update when different work with the same name reaches the same state', () => {
  const tasks = [task, { ...task, id: 'second' }];
  const props = { persona, tasks, workItems: [], lifecycleLabel: 'Ready' };
  const view = render(<PersonaStatusUpdates {...props} />);
  view.rerender(<PersonaStatusUpdates {...props} tasks={[{ ...task, state: 'completed' }, tasks[1]]} />);
  const firstMessage = screen.getByRole('status').firstChild;
  view.rerender(<PersonaStatusUpdates {...props} tasks={tasks.map(item => ({ ...item, state: 'completed' }))} />);
  expect(screen.getByRole('status')).toHaveTextContent('Review the receipt: Completed');
  expect(screen.getByRole('status').firstChild).not.toBe(firstMessage);
});

it('does not announce initial history or carry announcements across Persona navigation', () => {
  const props = { persona, tasks: [{ ...task, state: 'completed' as const }], workItems: [], lifecycleLabel: 'Ready' };
  const view = render(<PersonaStatusUpdates {...props} />);
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
  view.rerender(<PersonaStatusUpdates {...props} persona={{ ...persona, lifecycleState: 'busy' }} lifecycleLabel="Working now" />);
  expect(screen.getByRole('status')).toHaveTextContent('Alex: Working now');
  view.rerender(<PersonaStatusUpdates {...props} persona={{ ...persona, id: 'other', name: 'Other Persona' }} />);
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
});

it('uses the selected language while preserving the owner-authored title', () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'de');
  const props = { persona, tasks: [task], workItems: [], lifecycleLabel: 'Bereit' };
  const view = render(<I18nProvider><PersonaStatusUpdates {...props} /></I18nProvider>);
  view.rerender(<I18nProvider><PersonaStatusUpdates {...props} tasks={[{ ...task, state: 'completed' }]} /></I18nProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('Review the receipt: Abgeschlossen');
});
