/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const createMock = jest.fn();
const createDraftMock = jest.fn();
const updateDraftMock = jest.fn();
const deleteDraftMock = jest.fn();
const rolesMock = jest.fn();
const readinessMock = jest.fn();
const loadFlowsMock = jest.fn();

jest.mock('@/frontend/services/personas', () => ({
  personasService: {
    create: (...args: unknown[]) => createMock(...args),
    createDraft: (...args: unknown[]) => createDraftMock(...args),
    updateDraft: (...args: unknown[]) => updateDraftMock(...args),
    deleteDraft: (...args: unknown[]) => deleteDraftMock(...args),
    roles: (...args: unknown[]) => rolesMock(...args),
    flowReadiness: (...args: unknown[]) => readinessMock(...args),
  },
}));

jest.mock('@/frontend/services/flow', () => ({
  flowService: { loadFlows: (...args: unknown[]) => loadFlowsMock(...args) },
}));

jest.mock('@/frontend/components/mcp/useMcpAppsDiscovery', () => ({
  useMcpAppsDiscovery: () => ({ servers: [], loading: false, error: null }),
}));

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

const flow = {
  id: 'core_flow',
  name: 'Helpful Core',
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

describe('PersonaCreationWizard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rolesMock.mockResolvedValue({ roleDefinitions: [], roleVersions: [role] });
    loadFlowsMock.mockResolvedValue([flow]);
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

  it('preserves its draft across Back and submits one stable creation bundle', async () => {
    const onCreated = jest.fn();
    render(
      <PersonaCreationWizard
        open
        onClose={jest.fn()}
        onCreated={onCreated}
        onDraftSaved={jest.fn()}
        onDraftDiscarded={jest.fn()}
      />,
    );

    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), {
      target: { value: 'Mina' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('personas.create.roleTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'personas.create.back' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Mina');

    for (let index = 0; index < 4; index += 1) {
      const next = await screen.findByRole('button', {
        name: /Next|personas.create.skip/,
      });
      await waitFor(() => expect(next).toBeEnabled());
      fireEvent.click(next);
    }

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

  it('saves an incomplete wizard without publishing a Persona', async () => {
    const onDraftSaved = jest.fn();
    render(
      <PersonaCreationWizard
        open
        onClose={jest.fn()}
        onCreated={jest.fn()}
        onDraftSaved={onDraftSaved}
        onDraftDiscarded={jest.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'personas.create.saveDraft' }));
    await waitFor(() => expect(createDraftMock).toHaveBeenCalledTimes(1));
    expect(createDraftMock.mock.calls[0][0]).toMatchObject({
      id: expect.stringMatching(/^draft_/),
      payload: expect.objectContaining({ name: '', step: 0 }),
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(onDraftSaved).toHaveBeenCalledTimes(1);
  });

  it('refreshes Roles once when focus and visibility return together', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    render(
      <PersonaCreationWizard
        open
        onClose={jest.fn()}
        onCreated={jest.fn()}
        onDraftSaved={jest.fn()}
        onDraftDiscarded={jest.fn()}
      />,
    );
    await waitFor(() => expect(rolesMock).toHaveBeenCalledTimes(1));

    now = 2_000;
    fireEvent.focus(window);
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(rolesMock).toHaveBeenCalledTimes(2));
    nowSpy.mockRestore();
  });
});
