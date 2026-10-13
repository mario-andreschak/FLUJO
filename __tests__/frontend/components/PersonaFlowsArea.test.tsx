/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { PersonaDetail } from '@/frontend/services/personas';
import type { PersonaComposition } from '@/shared/types/enduringAgent';

const getCompositionMock = jest.fn();
const activateBehaviorMock = jest.fn();
const loadFlowsMock = jest.fn();
const addBehaviorMock = jest.fn();
const updateCompositionMock = jest.fn();

jest.mock('@/frontend/services/personas', () => ({
  ...jest.requireActual('@/frontend/services/personas'),
  personasService: {
    getComposition: (...args: unknown[]) => getCompositionMock(...args),
    activateBehavior: (...args: unknown[]) => activateBehaviorMock(...args),
    addBehavior: (...args: unknown[]) => addBehaviorMock(...args),
    updateComposition: (...args: unknown[]) => updateCompositionMock(...args),
  },
}));

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    loadFlows: (...args: unknown[]) => loadFlowsMock(...args),
  },
}));

jest.mock('@/frontend/hooks/useCardPicker', () => ({
  useCardPicker: (_kind: string, items: unknown[]) => ({
    searchTerm: '',
    setSearchTerm: jest.fn(),
    items,
  }),
}));

jest.mock('@/frontend/components/Flow/FlowDashboard/FlowCard', () => ({
  __esModule: true,
  default: ({ flow }: { flow: { name: string } }) => <div>{flow.name}</div>,
  FlowCardSkeleton: () => <div>Loading Flow</div>,
}));

jest.mock('@/frontend/components/shared/CardPickerDialog', () => ({
  __esModule: true,
  default: ({ open, items }: { open: boolean; items: { key: string; content: React.ReactNode }[] }) => (
    open ? <div role="dialog">{items.map((item) => <div key={item.key}>{item.content}</div>)}</div> : null
  ),
}));

import PersonaFlowsArea from '@/frontend/components/Personas/PersonaFlowsArea';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { LOCALE_STORAGE_KEY, type SupportedLocale } from '@/frontend/i18n/locales';
import { catalogs } from '@/frontend/i18n/messages';
import { PersonasApiError } from '@/frontend/services/personas';

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
    localStorage.clear();
    getCompositionMock.mockResolvedValue(composition);
    loadFlowsMock.mockResolvedValue([]);
    addBehaviorMock.mockResolvedValue(composition);
    updateCompositionMock.mockReset().mockResolvedValue(composition);
    activateBehaviorMock.mockResolvedValue({
      binding: { ...binding, activeRevisionId: earlierRevision.id },
      revision: earlierRevision,
    });
  });

  it.each<SupportedLocale>(['en', 'es', 'de', 'fr', 'it', 'pt', 'zh-CN'])('keeps the rename draft focused, explains a conflict in %s, and retries with the refreshed guard', async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const onChanged = jest.fn().mockResolvedValue(undefined);
    render(<I18nProvider><PersonaFlowsArea detail={detail} onChanged={onChanged} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: catalogs[locale]['personas.behaviors.rename'] }));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByRole('textbox', { name: catalogs[locale]['personas.behaviors.name'] });
    fireEvent.change(input, { target: { value: 'Unsaved specialist name' } });
    const refreshed = { ...composition, expectedUpdatedAt: 40 };
    getCompositionMock.mockResolvedValue(refreshed);
    updateCompositionMock.mockRejectedValueOnce(new PersonasApiError(409, 'Persona composition changed since it was inspected.')).mockResolvedValueOnce(refreshed);
    const save = within(dialog).getByRole('button', { name: catalogs[locale]['personas.action.save'] });
    save.focus();
    fireEvent.click(save);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(catalogs[locale]['personas.flows.changed']);
    expect(input).toHaveValue('Unsaved specialist name');
    expect(save).toHaveFocus();
    expect(updateCompositionMock).toHaveBeenCalledWith('jim', expect.objectContaining({ expectedUpdatedAt: 20 }));
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(save);
    await waitFor(() => expect(updateCompositionMock).toHaveBeenCalledTimes(2));
    expect(updateCompositionMock).toHaveBeenLastCalledWith('jim', expect.objectContaining({ expectedUpdatedAt: 40, behaviors: [expect.objectContaining({ name: 'Unsaved specialist name' })] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('retains the draft and refresh failure guidance when the changed composition cannot be reloaded', async () => {
    render(<PersonaFlowsArea detail={detail} onChanged={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByRole('textbox', { name: 'Behavior name' });
    fireEvent.change(input, { target: { value: 'Retained offline draft' } });
    getCompositionMock.mockRejectedValue(new Error('Current Flows unavailable; try again when connected.'));
    updateCompositionMock.mockRejectedValue(new PersonasApiError(409, 'Changed elsewhere'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Current Flows unavailable; try again when connected.');
    expect(input).toHaveValue('Retained offline draft');
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

  it('distinguishes a Persona copy and explains how to repair an invalid Flow without exposing diagnostics by default', async () => {
    getCompositionMock.mockResolvedValue({ ...composition, behaviorCards: [{
      ...composition.behaviorCards[0],
      binding: { mode: 'persona_copy', sharedFlowRef: 'shared-source', personaFlowRef: 'flow_current' },
      readiness: { state: 'invalid', issues: ['Model missing at internal-node-id'] },
    }] });
    render(<PersonaFlowsArea detail={detail} onChanged={jest.fn()} />);
    expect(await screen.findByText('Persona copy')).toBeInTheDocument();
    expect(screen.getByText('Shared Flow')).toBeInTheDocument();
    expect(screen.getByText('Open this Flow in the Flow Builder to check its model and connections before running it.')).toBeInTheDocument();
    expect(screen.getByText('Model missing at internal-node-id').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Reset to shared Flow' })).toBeInTheDocument();
  });

  it.each(['Use this Flow', 'Make a copy for this Persona'])('can add a new specialist through %s even when every existing binding is configured', async (choice) => {
    loadFlowsMock.mockResolvedValue([{ id: 'new-specialist', name: 'New specialist', nodes: [], edges: [] }]);
    render(<PersonaFlowsArea detail={detail} onChanged={jest.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Behavior' }));
    fireEvent.click(screen.getByRole('button', { name: choice }));
    await waitFor(() => expect(addBehaviorMock).toHaveBeenCalledWith('jim', {
      expectedUpdatedAt: 20, sourceFlowRef: 'new-specialist',
      mode: choice === 'Use this Flow' ? 'shared' : 'persona_copy',
    }));
  });

  it('presents the primary binding through Core and identifies maintenance as automatic', async () => {
    getCompositionMock.mockResolvedValue({ ...composition, behaviorCards: [
      { ...composition.behaviorCards[0], ref: 'primary', slotKey: 'primary', name: 'Hidden primary duplicate' },
      { ...composition.behaviorCards[0], ref: 'maintenance', slotKey: 'maintain_memory', name: 'Maintain memory' },
    ] });
    render(<PersonaFlowsArea detail={detail} onChanged={jest.fn()} />);
    expect(await screen.findByText('Automatic maintenance')).toBeInTheDocument();
    expect(screen.getByText('FLUJO schedules this Flow to maintain memory. Core cannot call it as a specialist.')).toBeInTheDocument();
    expect(screen.queryByText('Hidden primary duplicate')).not.toBeInTheDocument();
    expect(screen.queryByText('Callable specialist')).not.toBeInTheDocument();
  });

  it('localizes the platform maintenance label while preserving an owner-authored label pair', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'de');
    getCompositionMock.mockResolvedValue({ ...composition, behaviorCards: [
      { ...composition.behaviorCards[0], ref: 'maintenance', slotKey: 'maintain_memory', name: 'Maintain memory',
        description: 'Propose a bounded set of trustworthy, provenance-bearing memories after an Activity.' },
      { ...composition.behaviorCards[0], ref: 'custom-maintenance', slotKey: 'maintain_memory', name: 'Maintain memory',
        description: 'My owner-authored description.' },
    ] });
    try {
      render(<I18nProvider><PersonaFlowsArea detail={detail} onChanged={jest.fn()} /></I18nProvider>);
      expect(await screen.findByRole('heading', { name: 'Erinnerungen pflegen' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Maintain memory' })).toBeInTheDocument();
    } finally {
      localStorage.removeItem(LOCALE_STORAGE_KEY);
    }
  });
});
