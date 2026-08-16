/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Persona, PersonaComposition } from '@/shared/types/enduringAgent';
import type { PlannedExecution } from '@/shared/types/plannedExecution';

const loadFlowsMock = jest.fn();
const listPersonasMock = jest.fn();
const getCompositionMock = jest.fn();
const createMock = jest.fn();
const updateMock = jest.fn();

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
    })));
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
