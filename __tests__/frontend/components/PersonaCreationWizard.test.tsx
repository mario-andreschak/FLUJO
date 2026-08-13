/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ComponentProps } from 'react';

const createMock = jest.fn();
const createDraftMock = jest.fn();
const updateDraftMock = jest.fn();
const deleteDraftMock = jest.fn();
const rolesMock = jest.fn();
const readinessMock = jest.fn();
const loadFlowsMock = jest.fn();

jest.mock('@/frontend/services/personas', () => {
  class PersonasApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
      this.name = 'PersonasApiError';
    }
  }

  return {
    PersonasApiError,
    personasService: {
      create: (...args: unknown[]) => createMock(...args),
      createDraft: (...args: unknown[]) => createDraftMock(...args),
      updateDraft: (...args: unknown[]) => updateDraftMock(...args),
      deleteDraft: (...args: unknown[]) => deleteDraftMock(...args),
      roles: (...args: unknown[]) => rolesMock(...args),
      flowReadiness: (...args: unknown[]) => readinessMock(...args),
    },
  };
});

jest.mock('@/frontend/services/flow', () => ({
  flowService: { loadFlows: (...args: unknown[]) => loadFlowsMock(...args) },
}));

jest.mock('@/frontend/components/mcp/useMcpAppsDiscovery', () => {
  const servers = [{
    name: 'calendar',
    config: { rootPath: '/calendar', transport: 'stdio' },
  }];
  return {
    useMcpAppsDiscovery: () => ({
      servers,
      loading: false,
      error: null,
    }),
  };
});

jest.mock('@/frontend/contexts/I18nContext', () => {
  const t = (key: string, values?: Record<string, unknown>) => {
    const copy: Record<string, string> = {
      'personas.create.title': 'Create a Persona',
      'personas.create.step.identity': 'About',
      'personas.create.step.role': 'Role',
      'personas.create.step.core': 'Main Flow',
      'personas.create.step.behaviors': 'Behaviors',
      'personas.create.step.apps': 'Apps',
      'personas.create.step.memories': 'Memories',
      'personas.create.step.review': 'Review',
      'personas.create.identity.title': 'Who are you creating?',
      'personas.create.name': 'Name',
      'personas.create.picture': 'Picture URL',
      'personas.create.purpose': 'Purpose',
      'personas.create.next': 'Next',
      'personas.create.finish': 'Create Persona',
    };
    return copy[key] ?? key.replace('{number}', String(values?.number ?? ''));
  };

  return {
    useI18n: () => ({
      t,
      tp: (key: string, count: number) => `${key}:${count}`,
      formatNumber: (value: number) => String(value),
    }),
  };
});

import PersonaCreationWizard from '@/frontend/components/Personas/PersonaCreationWizard';
import type {
  PersonaCreationDraft,
  PersonaCreationDraftPayload,
} from '@/shared/types/enduringAgent';

const flow = {
  id: 'core_flow',
  name: 'Helpful Core',
  nodes: [],
  edges: [],
};

const behaviorFlow = {
  id: 'behavior_flow',
  name: 'Research',
  nodes: [],
  edges: [],
};

const role = {
  schemaVersion: 2,
  id: 'role_version',
  roleDefinitionId: 'role_definition',
  version: 1,
  name: 'Helper',
  mission: 'Help with useful work.',
  behaviorSlots: [
    {
      key: 'primary',
      name: 'Primary',
      flowTemplate: flow,
    },
  ],
  createdAt: 1,
};

const fullPayload: PersonaCreationDraftPayload = {
  step: 3,
  name: 'Mina',
  mission: 'Keep projects moving.',
  avatarUrl: 'https://example.test/mina.png',
  roleVersionId: 'role_version',
  coreFlowRef: 'core_flow',
  behaviorFlowRefs: ['behavior_flow'],
  appRefs: ['calendar'],
  appsEdited: true,
  memories: ['Prefers concise updates.', 'Owns the launch checklist.'],
  idempotencyKey: 'stable-final-create-key',
};

function draftRecord(
  payload: PersonaCreationDraftPayload = fullPayload,
): PersonaCreationDraft {
  return {
    schemaVersion: 1,
    id: 'draft_existing',
    workspaceId: 'test',
    status: 'draft',
    payload,
    revision: 4,
    createdAt: 1,
    updatedAt: 2,
  };
}

function wizard(
  props: Partial<ComponentProps<typeof PersonaCreationWizard>> = {},
) {
  return (
    <PersonaCreationWizard
      open
      onClose={jest.fn()}
      onCreated={jest.fn()}
      onDraftSaved={jest.fn()}
      onDraftDiscarded={jest.fn()}
      {...props}
    />
  );
}

async function advanceToReview(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    const next = await screen.findByRole('button', {
      name: /Next|personas.create.skip/,
    });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('PersonaCreationWizard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rolesMock.mockResolvedValue({ roleDefinitions: [], roleVersions: [role] });
    loadFlowsMock.mockResolvedValue([flow, behaviorFlow]);
    readinessMock.mockResolvedValue({ state: 'ready', issues: [] });
    createMock.mockResolvedValue({ persona: { id: 'persona_1' } });
    createDraftMock.mockImplementation(async (input) => ({
      schemaVersion: 1,
      id: input.id,
      workspaceId: 'test',
      status: 'draft',
      payload: input.payload,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }));
    updateDraftMock.mockImplementation(async (_id, input) => ({
      schemaVersion: 1,
      id: 'draft_existing',
      workspaceId: 'test',
      status: 'draft',
      payload: input.payload,
      revision: input.expectedRevision + 1,
      createdAt: 1,
      updatedAt: 2,
    }));
    deleteDraftMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves its draft across Back and submits one stable five-step creation bundle', async () => {
    const onCreated = jest.fn();
    render(wizard({ onCreated }));

    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), {
      target: { value: 'Mina' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('personas.create.roleTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'personas.create.back' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Mina');

    await advanceToReview();

    fireEvent.click(await screen.findByRole('button', { name: 'Create Persona' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][0]).toMatchObject({
      name: 'Mina',
      roleVersionId: 'role_version',
      coreFlowRef: 'core_flow',
      behaviorFlowRefs: [],
      appRefs: [],
    });
    expect(createMock.mock.calls[0][0].idempotencyKey).toEqual(expect.any(String));
    expect(onCreated).toHaveBeenCalled();
  });

  it('preserves every hydrated field through explicit save at the current step', async () => {
    const onDraftSaved = jest.fn();
    render(wizard({
      draft: draftRecord(),
      onDraftSaved,
    }));

    expect(await screen.findByText('personas.create.behaviorsTitle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'personas.create.saveDraft' }));

    await waitFor(() => expect(updateDraftMock).toHaveBeenCalledTimes(1));
    expect(updateDraftMock).toHaveBeenCalledWith('draft_existing', {
      expectedRevision: 4,
      payload: fullPayload,
    });
    expect(onDraftSaved).toHaveBeenCalledWith(expect.objectContaining({
      id: 'draft_existing',
      payload: fullPayload,
      revision: 5,
    }));
  });

  it('keeps default Apps for a genuinely new, unedited wizard', async () => {
    rolesMock.mockResolvedValue({
      roleDefinitions: [],
      roleVersions: [{
        ...role,
        capabilityRequirements: { preferredMcpServers: ['calendar'] },
      }],
    });
    render(wizard());

    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), {
      target: { value: 'Mina' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Helper');
    fireEvent.click(screen.getByRole('button', { name: 'personas.create.saveDraft' }));

    await waitFor(() => expect(createDraftMock).toHaveBeenCalledTimes(1));
    expect(createDraftMock.mock.calls[0][0].payload).toMatchObject({
      step: 1,
      appRefs: ['calendar'],
      appsEdited: false,
    });
  });

  it('retries a transient new-draft save with the same id and payload', async () => {
    createDraftMock.mockRejectedValueOnce(new Error('temporary save failure'));
    const onDraftSaved = jest.fn();
    render(wizard({ onDraftSaved }));

    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), {
      target: { value: 'Mina' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'personas.create.saveDraft' }));
    expect(await screen.findByText('temporary save failure')).toBeInTheDocument();

    const firstAttempt = createDraftMock.mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'personas.create.saveDraft' }));

    await waitFor(() => expect(createDraftMock).toHaveBeenCalledTimes(2));
    expect(createDraftMock.mock.calls[1][0]).toEqual(firstAttempt);
    expect(firstAttempt.id).toMatch(/^draft_/);
    expect(onDraftSaved).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refreshes Roles when the wizard re-enters', async () => {
    const view = render(wizard());
    await waitFor(() => expect(rolesMock).toHaveBeenCalledTimes(1));

    view.rerender(wizard({ open: false }));
    view.rerender(wizard({ open: true }));

    await waitFor(() => expect(rolesMock).toHaveBeenCalledTimes(2));
    expect(loadFlowsMock).toHaveBeenCalledTimes(2);
  });

  it('preserves local values, selection, and step during a focus refresh', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const refreshedRole = {
      ...role,
      id: 'role_version_new',
      version: 2,
      name: 'New Role',
    };
    rolesMock
      .mockResolvedValueOnce({ roleDefinitions: [], roleVersions: [role] })
      .mockResolvedValueOnce({
        roleDefinitions: [],
        roleVersions: [role, refreshedRole],
      });

    render(wizard());
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), {
      target: { value: 'Mina' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Picture URL' }), {
      target: { value: 'https://example.test/mina.png' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), {
      target: { value: 'Keep projects moving.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('personas.create.roleTitle')).toBeInTheDocument();

    now = 2_000;
    fireEvent.focus(window);
    await waitFor(() => expect(rolesMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText('personas.create.roleTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'personas.create.saveDraft' }));
    await waitFor(() => expect(createDraftMock).toHaveBeenCalledTimes(1));
    expect(createDraftMock.mock.calls[0][0].payload).toMatchObject({
      step: 1,
      name: 'Mina',
      mission: 'Keep projects moving.',
      avatarUrl: 'https://example.test/mina.png',
      roleVersionId: 'role_version',
      coreFlowRef: 'core_flow',
    });
  });

  it('coalesces return events and ignores an older overlapping Role response', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    render(wizard());
    await waitFor(() => expect(rolesMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Mina' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('personas.create.roleTitle');

    const older = deferred<{ roleDefinitions: never[]; roleVersions: Array<typeof role> }>();
    const newer = deferred<{ roleDefinitions: never[]; roleVersions: Array<typeof role> }>();
    const staleRole = { ...role, id: 'role_stale', name: 'Stale Role' };
    const newestRole = { ...role, id: 'role_newest', name: 'Newest Role' };
    rolesMock
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const refreshButton = screen.getByRole('button', {
      name: 'personas.create.refreshRoles',
    });
    fireEvent.click(refreshButton);
    fireEvent.click(refreshButton);
    expect(rolesMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      newer.resolve({
        roleDefinitions: [],
        roleVersions: [role, newestRole],
      });
    });
    expect(screen.getAllByText('Newest Role').length).toBeGreaterThan(0);

    await act(async () => {
      older.resolve({
        roleDefinitions: [],
        roleVersions: [role, staleRole],
      });
    });
    expect(screen.queryAllByText('Stale Role')).toHaveLength(0);

    now = 2_000;
    fireEvent.focus(window);
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(rolesMock).toHaveBeenCalledTimes(4));
  });

  it('deletes the source draft only after successful Persona creation', async () => {
    const onDraftDiscarded = jest.fn();
    render(wizard({
      draft: draftRecord({ ...fullPayload, step: 4 }),
      onDraftDiscarded,
    }));

    const finish = await screen.findByRole('button', { name: 'Create Persona' });
    await waitFor(() => expect(finish).toBeEnabled());
    fireEvent.click(finish);

    await waitFor(() => expect(deleteDraftMock).toHaveBeenCalledTimes(1));
    expect(deleteDraftMock).toHaveBeenCalledWith('draft_existing', {
      expectedRevision: 4,
    });
    expect(createMock.mock.invocationCallOrder[0])
      .toBeLessThan(deleteDraftMock.mock.invocationCallOrder[0]);
    expect(onDraftDiscarded).toHaveBeenCalledWith('draft_existing');
  });

  it('retains a resumed draft and all values when Persona creation fails', async () => {
    createMock.mockRejectedValueOnce(new Error('Persona create failed'));
    render(wizard({
      draft: draftRecord({ ...fullPayload, step: 4 }),
    }));

    const finish = await screen.findByRole('button', { name: 'Create Persona' });
    await waitFor(() => expect(finish).toBeEnabled());
    fireEvent.click(finish);

    expect(await screen.findByText('Persona create failed')).toBeInTheDocument();
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      appRefs: ['calendar'],
      idempotencyKey: fullPayload.idempotencyKey,
    }));
    expect(deleteDraftMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'personas.create.saveDraft' }));
    await waitFor(() => expect(updateDraftMock).toHaveBeenCalledTimes(1));
    expect(updateDraftMock).toHaveBeenCalledWith('draft_existing', {
      expectedRevision: 4,
      payload: { ...fullPayload, step: 4 },
    });
  });
});
