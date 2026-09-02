/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Persona, PersonaComposition } from '@/shared/types/enduringAgent';
import type { PlannedExecution } from '@/shared/types/plannedExecution';

const loadFlowsMock = jest.fn();
const listPersonasMock = jest.fn();
const getCompositionMock = jest.fn();
const createMock = jest.fn();
const updateMock = jest.fn();
const scrollIntoViewMock = jest.fn();
let intersectionCallback: IntersectionObserverCallback | undefined;
let observedSections: Element[] = [];

class MockIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }

  observe(element: Element) {
    observedSections.push(element);
  }

  unobserve() {}
  disconnect() {}
}

jest.mock('@/frontend/services/flow', () => ({
  flowService: { loadFlows: (...args: unknown[]) => loadFlowsMock(...args) },
}));

jest.mock('@/frontend/services/personas', () => ({
  personasService: {
    list: (...args: unknown[]) => listPersonasMock(...args),
    getComposition: (...args: unknown[]) => getCompositionMock(...args),
  },
}));

jest.mock('@/frontend/services/plannedExecutions', () => ({
  plannedExecutionsService: {
    create: (...args: unknown[]) => createMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

jest.mock('@/frontend/components/Chat/FlowSelector', () => ({
  __esModule: true,
  default: ({
    selectedFlowId,
    onSelectFlow,
  }: {
    selectedFlowId: string | null;
    onSelectFlow: (flowId: string) => void;
  }) => (
    <div>
      <span data-testid="selected-flow">{selectedFlowId ?? ''}</span>
      <button type="button" onClick={() => onSelectFlow('flow-manual')}>
        choose-flow
      </button>
    </div>
  ),
}));

jest.mock('@/frontend/components/PlannedExecutions/SchedulePanel', () => ({
  __esModule: true,
  default: () => <div data-testid="schedule-panel" />,
}));

jest.mock('@/frontend/components/shared/DialogHeaderActions', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

import ExecutionModal from '@/frontend/components/PlannedExecutions/ExecutionModal';

Object.defineProperty(global.crypto, 'randomUUID', {
  configurable: true,
  value: () => 'draft-execution',
});

const persona = {
  schemaVersion: 2,
  id: 'persona-ari',
  name: 'Ari',
  roleVersionId: 'role-version',
  lifecycleState: 'idle',
  autonomyLevel: 'propose_overrides',
  interruptionPolicy: 'queue',
  provisioningState: 'ready',
  createdAt: 1,
  updatedAt: 1,
} as Persona;

const composition: PersonaComposition = {
  personaRef: persona.id,
  name: persona.name,
  description: 'A helpful teammate.',
  role: {
    ref: 'role-definition',
    name: 'Assistant',
    prompt: 'Help with useful work.',
    suggestedAppRefs: [],
  },
  coreFlowRef: 'flow-core',
  core: {
    binding: { mode: 'shared', sharedFlowRef: 'flow-core' },
    effectiveFlowRef: 'flow-core',
    readiness: { state: 'ready', issues: [] },
  },
  appRefs: [],
  memories: [],
  behaviors: [],
  behaviorCards: [{
    ref: 'behavior-research',
    slotKey: 'research',
    name: 'Research deeply',
    description: 'Investigate a topic before answering.',
    order: 0,
    binding: { mode: 'shared', sharedFlowRef: 'flow-research' },
    effectiveFlowRef: 'flow-research',
    readiness: { state: 'ready', issues: [] },
  }],
  expectedUpdatedAt: 1,
};

const legacyExclusiveExecution: PlannedExecution = {
  id: 'execution-legacy-exclusive',
  name: 'Legacy exclusive',
  enabled: true,
  flowId: 'flow-manual',
  prompt: '',
  trigger: { type: 'schedule', cron: '0 9 * * *' },
  exclusive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const personaExecution: PlannedExecution = {
  id: 'execution-persona',
  name: 'Daily research',
  enabled: true,
  flowId: 'flow-research',
  personaId: persona.id,
  behaviorSlotKey: 'research',
  prompt: 'Review the new material and report what matters.',
  trigger: { type: 'schedule', cron: '0 9 * * *' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('ExecutionModal Persona targets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    observedSections = [];
    intersectionCallback = undefined;
    Object.defineProperty(global, 'IntersectionObserver', {
      configurable: true,
      writable: true,
      value: MockIntersectionObserver,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoViewMock,
    });
    loadFlowsMock.mockResolvedValue([
      { id: 'flow-manual', name: 'Manual flow', nodes: [], edges: [] },
    ]);
    listPersonasMock.mockResolvedValue([persona]);
    getCompositionMock.mockResolvedValue(composition);
    createMock.mockResolvedValue({ success: true });
    updateMock.mockResolvedValue({ success: true });
  });

  it('creates an Automation for a Persona and one of their named skills', async () => {
    render(
      <ExecutionModal
        open
        execution={null}
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />,
    );

    const personaChoice = screen.getByText('automations.modal.targetPersona').closest('[role="radio"]');
    expect(personaChoice).not.toBeNull();
    fireEvent.click(personaChoice!);

    await waitFor(() => expect(listPersonasMock).toHaveBeenCalled());
    const personaPicker = await screen.findByRole('combobox', {
      name: 'automations.modal.persona',
    });
    fireEvent.mouseDown(personaPicker);
    fireEvent.click(await screen.findByRole('option', { name: 'Ari' }));

    await waitFor(() => expect(getCompositionMock).toHaveBeenCalledWith(persona.id));
    const skillPicker = await screen.findByRole('combobox', {
      name: 'automations.modal.personaSkill',
    });
    fireEvent.mouseDown(skillPicker);
    fireEvent.click(await screen.findByRole('option', { name: 'Research deeply' }));

    fireEvent.change(screen.getByLabelText('automations.modal.name'), {
      target: { value: 'Watch the market' },
    });

    const save = screen.getByRole('button', { name: 'automations.modal.saveTrigger' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'draft-execution',
      name: 'Watch the market',
      personaId: persona.id,
      behaviorSlotKey: 'research',
      flowId: 'flow-research',
      startRestriction: 'unrestricted',
      superExclusive: false,
      emergency: false,
    })));
  });

  it('renders three linked sections and persists canonical restriction controls', async () => {
    render(
      <ExecutionModal
        open
        execution={null}
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />,
    );

    expect(screen.getByRole('tablist', {
      name: 'automations.modal.sectionsAria',
    })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByTestId('execution-modal-scroll-container')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('automations.modal.name'), {
      target: { value: 'Restricted flow' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'choose-flow' }));

    const singleton = screen
      .getByText('automations.modal.restriction.singleton.title')
      .closest('[role="radio"]');
    const superExclusive = screen
      .getByText('automations.modal.superExclusiveTitle')
      .closest('[role="switch"]');
    const emergency = screen
      .getByText('automations.modal.emergencyTitle')
      .closest('[role="switch"]');
    expect(singleton).not.toBeNull();
    expect(superExclusive).not.toBeNull();
    expect(emergency).not.toBeNull();
    fireEvent.click(singleton!);
    fireEvent.click(superExclusive!);
    fireEvent.click(emergency!);

    fireEvent.click(screen.getByRole('button', {
      name: 'automations.modal.saveTrigger',
    }));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      startRestriction: 'singleton',
      superExclusive: true,
      emergency: true,
      overlapStrategy: 'skip',
    })));
  });

  it('links visible labels and descriptions to keyboard-operable restriction cards', () => {
    render(
      <ExecutionModal open execution={null} onClose={jest.fn()} onSaved={jest.fn()} />,
    );

    const unrestricted = screen.getByRole('radio', {
      name: 'automations.modal.restriction.unrestricted.title',
    });
    const singleton = screen.getByRole('radio', {
      name: 'automations.modal.restriction.singleton.title',
    });

    expect(unrestricted).toHaveAttribute('aria-checked', 'true');
    expect(unrestricted).toHaveAttribute(
      'aria-describedby',
      'automation-restriction-unrestricted-description',
    );
    expect(unrestricted.querySelector('[data-testid="restriction-selected-icon"]'))
      .not.toBeNull();
    expect(screen.getAllByTestId('restriction-selected-icon')).toHaveLength(1);

    fireEvent.keyDown(unrestricted, { key: 'ArrowRight' });

    expect(singleton).toHaveAttribute('aria-checked', 'true');
    expect(singleton).toHaveFocus();
    expect(unrestricted).toHaveAttribute('tabindex', '-1');
    expect(singleton).toHaveAttribute('tabindex', '0');
  });

  it('toggles both override cards from the keyboard with accessible descriptions', () => {
    render(
      <ExecutionModal open execution={null} onClose={jest.fn()} onSaved={jest.fn()} />,
    );

    const superExclusive = screen.getByRole('switch', {
      name: 'automations.modal.superExclusiveTitle',
    });
    const emergency = screen.getByRole('switch', {
      name: 'automations.modal.emergencyTitle',
    });
    expect(superExclusive).toHaveAttribute(
      'aria-describedby',
      'automation-super-exclusive-description',
    );
    expect(emergency).toHaveAttribute(
      'aria-describedby',
      'automation-emergency-description',
    );

    fireEvent.keyDown(superExclusive, { key: 'Enter' });
    fireEvent.keyDown(emergency, { key: ' ' });

    expect(superExclusive).toHaveAttribute('aria-checked', 'true');
    expect(emergency).toHaveAttribute('aria-checked', 'true');
  });

  it('renders legacy Exclusive as Exclusive plus Super-Exclusive', () => {
    render(
      <ExecutionModal
        open
        execution={legacyExclusiveExecution}
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />,
    );

    expect(screen.getByRole('radio', {
      name: 'automations.modal.restriction.exclusive.title',
    })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', {
      name: 'automations.modal.superExclusiveTitle',
    })).toHaveAttribute('aria-checked', 'true');
  });

  it('scrolls to a selected section and suppresses observer flicker during that scroll', () => {
    render(
      <ExecutionModal open execution={null} onClose={jest.fn()} onSaved={jest.fn()} />,
    );

    const restrictionsTab = screen.getByRole('tab', {
      name: 'automations.modal.section.restrictions',
    });
    fireEvent.click(restrictionsTab);

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    const whenSection = observedSections.find(
      (section) => section.getAttribute('data-section') === 'when',
    );
    expect(whenSection).toBeDefined();

    act(() => {
      intersectionCallback?.([{
        target: whenSection!,
        isIntersecting: true,
        intersectionRatio: 1,
      } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(restrictionsTab).toHaveAttribute('aria-selected', 'true');
  });

  it('updates the active tab from the most visible section', () => {
    render(
      <ExecutionModal open execution={null} onClose={jest.fn()} onSaved={jest.fn()} />,
    );

    const restrictionsSection = observedSections.find(
      (section) => section.getAttribute('data-section') === 'restrictions',
    );
    expect(restrictionsSection).toBeDefined();

    act(() => {
      intersectionCallback?.([{
        target: restrictionsSection!,
        isIntersecting: true,
        intersectionRatio: 0.9,
      } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(screen.getByRole('tab', {
      name: 'automations.modal.section.restrictions',
    })).toHaveAttribute('aria-selected', 'true');
  });

  it('navigates to and focuses the first invalid section on save', async () => {
    render(
      <ExecutionModal open execution={null} onClose={jest.fn()} onSaved={jest.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', {
      name: 'automations.modal.saveTrigger',
    }));

    await waitFor(() => {
      expect(screen.getByLabelText('automations.modal.name')).toHaveFocus();
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('focuses target selection in the What section after the name is valid', async () => {
    render(
      <ExecutionModal open execution={null} onClose={jest.fn()} onSaved={jest.fn()} />,
    );

    fireEvent.change(screen.getByLabelText('automations.modal.name'), {
      target: { value: 'Missing target' },
    });
    fireEvent.click(screen.getByRole('button', {
      name: 'automations.modal.saveTrigger',
    }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'choose-flow' })).toHaveFocus();
    });
    expect(screen.getByRole('tab', {
      name: 'automations.modal.section.what',
    })).toHaveAttribute('aria-selected', 'true');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('preserves form state after a failed save', async () => {
    createMock.mockResolvedValueOnce({ success: false, error: 'save failed' });
    render(
      <ExecutionModal open execution={null} onClose={jest.fn()} onSaved={jest.fn()} />,
    );

    fireEvent.change(screen.getByLabelText('automations.modal.name'), {
      target: { value: 'Keep this value' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'choose-flow' }));
    fireEvent.click(screen.getByRole('radio', {
      name: 'automations.modal.restriction.singleton.title',
    }));
    fireEvent.click(screen.getByRole('button', {
      name: 'automations.modal.saveTrigger',
    }));

    expect(await screen.findByText('save failed')).toBeInTheDocument();
    expect(screen.getByLabelText('automations.modal.name')).toHaveValue('Keep this value');
    expect(screen.getByRole('radio', {
      name: 'automations.modal.restriction.singleton.title',
    })).toHaveAttribute('aria-checked', 'true');
  });

  it('sends explicit clear markers when an existing Persona Automation becomes a Flow', async () => {
    render(
      <ExecutionModal
        open
        execution={personaExecution}
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />,
    );

    await waitFor(() => expect(getCompositionMock).toHaveBeenCalledWith(persona.id));
    const flowChoice = screen.getByText('automations.modal.targetFlow').closest('[role="radio"]');
    expect(flowChoice).not.toBeNull();
    fireEvent.click(flowChoice!);
    fireEvent.click(screen.getByRole('button', { name: 'choose-flow' }));

    const save = screen.getByRole('button', { name: 'automations.modal.saveTrigger' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(
      personaExecution.id,
      expect.objectContaining({
        flowId: 'flow-manual',
        personaId: null,
        behaviorSlotKey: null,
      }),
    ));
  });
});
