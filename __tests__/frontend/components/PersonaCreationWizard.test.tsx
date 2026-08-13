/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const createMock = jest.fn();
const rolesMock = jest.fn();
const readinessMock = jest.fn();
const loadFlowsMock = jest.fn();

jest.mock('@/frontend/services/personas', () => ({
  personasService: {
    create: (...args: unknown[]) => createMock(...args),
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

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
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
    },
  }),
}));

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
  behaviorSlots: [],
  createdAt: 1,
};

describe('PersonaCreationWizard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rolesMock.mockResolvedValue({ roleDefinitions: [], roleVersions: [role] });
    loadFlowsMock.mockResolvedValue([flow]);
    readinessMock.mockResolvedValue({ state: 'ready', issues: [] });
    createMock.mockResolvedValue({ persona: { id: 'persona_1' } });
  });

  it('preserves its draft across Back and submits one stable creation bundle', async () => {
    const onCreated = jest.fn();
    render(<PersonaCreationWizard open onClose={jest.fn()} onCreated={onCreated} />);

    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), {
      target: { value: 'Mina' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('personas.create.roleTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'personas.create.back' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Mina');

    for (let index = 0; index < 6; index += 1) {
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
});
