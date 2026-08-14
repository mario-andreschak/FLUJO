/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { PersonaDetail } from '@/frontend/services/personas';
import type { PersonaComposition } from '@/shared/types/enduringAgent';

const getCompositionMock = jest.fn();
const activateBehaviorMock = jest.fn();
const loadFlowsMock = jest.fn();

jest.mock('@/frontend/services/personas', () => ({
  personasService: {
    getComposition: (...args: unknown[]) => getCompositionMock(...args),
    activateBehavior: (...args: unknown[]) => activateBehaviorMock(...args),
  },
}));

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    loadFlows: (...args: unknown[]) => loadFlowsMock(...args),
  },
}));

jest.mock('@/frontend/hooks/useCardPicker', () => ({
  useCardPicker: () => ({
    searchTerm: '',
    setSearchTerm: jest.fn(),
    items: [],
  }),
}));

jest.mock('@/frontend/components/Flow/FlowDashboard/FlowCard', () => ({
  __esModule: true,
  default: ({ flow }: { flow: { name: string } }) => <div>{flow.name}</div>,
  FlowCardSkeleton: () => <div>Loading Flow</div>,
}));

jest.mock('@/frontend/components/shared/CardPickerDialog', () => ({
  __esModule: true,
  default: () => null,
}));

import PersonaFlowsArea from '@/frontend/components/Personas/PersonaFlowsArea';

const currentRevision = {
  schemaVersion: 1 as const,
  id: 'revision_current',
  behaviorId: 'behavior_research',
  personaId: 'jim',
  slotKey: 'research',
  revision: 2,
  contentHash: 'b'.repeat(64),
  flowSnapshot: { id: 'flow_current', name: 'Careful research', nodes: [], edges: [] },
  source: { kind: 'persona_override' as const, parentRevisionId: 'revision_earlier' },
  createdAt: 20,
};

const earlierRevision = {
  schemaVersion: 1 as const,
  id: 'revision_earlier',
  behaviorId: 'behavior_research',
  personaId: 'jim',
  slotKey: 'research',
  revision: 1,
  contentHash: 'a'.repeat(64),
  flowSnapshot: { id: 'flow_earlier', name: 'Original research', nodes: [], edges: [] },
  source: {
    kind: 'role_template' as const,
    roleVersionId: 'rolever_research_v1',
    slotKey: 'research',
    templateFlowId: 'flow_earlier',
  },
  createdAt: 10,
};

const binding = {
  schemaVersion: 1 as const,
  id: 'behavior_research',
  personaId: 'jim',
  slotKey: 'research',
  activeRevisionId: currentRevision.id,
  createdAt: 1,
  updatedAt: 20,
};

const composition = {
  personaRef: 'jim',
  name: 'Jim',
  description: 'Research carefully.',
  role: {
    ref: 'role_research',
    name: 'Researcher',
    prompt: 'Research carefully.',
    suggestedAppRefs: [],
  },
  coreFlowRef: 'flow_core',
  core: {
    binding: { mode: 'shared' as const, sharedFlowRef: 'flow_core' },
    effectiveFlowRef: 'flow_core',
    flow: { id: 'flow_core', name: 'Core', nodes: [], edges: [] },
    readiness: { state: 'ready' as const, issues: [] },
  },
  appRefs: [],
  memories: [],
  behaviors: [{
    ref: binding.id,
    slotKey: 'research',
    name: 'Research specialist',
    order: 0,
    binding: { mode: 'shared' as const, sharedFlowRef: 'flow_current' },
  }],
  behaviorCards: [{
    ref: binding.id,
    slotKey: 'research',
    name: 'Research specialist',
    order: 0,
    binding: { mode: 'shared' as const, sharedFlowRef: 'flow_current' },
    effectiveFlowRef: 'flow_current',
    flow: currentRevision.flowSnapshot,
    readiness: { state: 'ready' as const, issues: [] },
  }],
  expectedUpdatedAt: 20,
} satisfies PersonaComposition;

const detail = {
  persona: { id: 'jim' },
  roleVersion: {
    behaviorSlots: [{ key: 'research', name: 'Research specialist' }],
  },
  behaviorBindings: [binding],
  behaviorRevisions: [currentRevision, earlierRevision],
} as unknown as PersonaDetail;

describe('PersonaFlowsArea Behavior versions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCompositionMock.mockResolvedValue(composition);
    loadFlowsMock.mockResolvedValue([]);
    activateBehaviorMock.mockResolvedValue({
      binding: { ...binding, activeRevisionId: earlierRevision.id },
      revision: earlierRevision,
    });
  });

  it('shows friendly version history and restores an earlier version with a guarded request', async () => {
    const onChanged = jest.fn().mockResolvedValue(undefined);
    const { container } = render(
      <PersonaFlowsArea detail={detail} onChanged={onChanged} />,
    );

    expect(await screen.findByText('Research specialist')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Earlier versions'));

    expect(screen.getByText('Version 2')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Version 1')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(currentRevision.id);
    expect(container).not.toHaveTextContent(earlierRevision.id);

    const fingerprint = screen.getByText(`Fingerprint: ${earlierRevision.contentHash}`);
    expect(fingerprint.closest('details')).not.toHaveAttribute('open');

    fireEvent.click(screen.getByRole('button', { name: 'Use this version' }));
    await waitFor(() => expect(activateBehaviorMock).toHaveBeenCalledWith(
      'jim',
      binding.id,
      {
        revisionId: earlierRevision.id,
        expectedActiveRevisionId: currentRevision.id,
      },
    ));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
