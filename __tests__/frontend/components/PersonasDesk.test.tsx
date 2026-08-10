/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const listMock = jest.fn();
const getMock = jest.fn();
const rolesMock = jest.fn();
const replaceMock = jest.fn();
const pushMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
}));

jest.mock('@/frontend/services/personas', () => ({
  personasService: {
    list: (...args: unknown[]) => listMock(...args),
    get: (...args: unknown[]) => getMock(...args),
    roles: (...args: unknown[]) => rolesMock(...args),
    startConversation: jest.fn(),
    update: jest.fn(),
    activateMemory: jest.fn(),
    correctMemory: jest.fn(),
    forgetMemory: jest.fn(),
    pinMemory: jest.fn(),
    createWorkItem: jest.fn(),
    updateWorkItem: jest.fn(),
    deleteWorkItem: jest.fn(),
    activateBehavior: jest.fn(),
    recoverRuntime: jest.fn(),
  },
}));

import PersonasDesk from '@/frontend/components/Personas';

const persona = {
  schemaVersion: 1,
  id: 'jim',
  name: 'Jim',
  roleVersionId: 'rolever_developer_v1',
  lifecycleState: 'idle',
  mission: 'Ship careful software.',
  autonomyLevel: 'locked',
  interruptionPolicy: 'queue',
  coreMemoryItemIds: ['memory_1'],
  provisioningState: 'ready',
  createdAt: 10,
  updatedAt: 20,
};

const detail = {
  persona,
  roleVersion: {
    schemaVersion: 1,
    id: 'rolever_developer_v1',
    roleDefinitionId: 'role_developer',
    version: 1,
    name: 'Developer',
    mission: 'Build software.',
    behaviorSlots: [{
      key: 'primary',
      name: 'Primary',
      description: 'Main development behavior.',
      flowTemplate: { id: 'flow_template', name: 'Template', nodes: [], edges: [] },
    }],
    createdAt: 1,
  },
  behaviorBindings: [{
    schemaVersion: 1,
    id: 'behavior_primary',
    personaId: 'jim',
    slotKey: 'primary',
    activeRevisionId: 'revision_2',
    createdAt: 1,
    updatedAt: 2,
  }],
  behaviorRevisions: [
    {
      schemaVersion: 1,
      id: 'revision_2',
      behaviorId: 'behavior_primary',
      personaId: 'jim',
      slotKey: 'primary',
      revision: 2,
      contentHash: 'b'.repeat(64),
      flowSnapshot: { id: 'flow_override', name: 'Reviewed override', nodes: [], edges: [] },
      source: { kind: 'persona_override', parentRevisionId: 'revision_1', evidenceRefs: ['review:1'] },
      createdAt: 3,
    },
    {
      schemaVersion: 1,
      id: 'revision_1',
      behaviorId: 'behavior_primary',
      personaId: 'jim',
      slotKey: 'primary',
      revision: 1,
      contentHash: 'a'.repeat(64),
      flowSnapshot: { id: 'flow_template', name: 'Role default', nodes: [], edges: [] },
      source: { kind: 'role_template', roleVersionId: 'rolever_developer_v1', slotKey: 'primary', templateFlowId: 'flow_template' },
      createdAt: 2,
    },
  ],
  memoryItems: [{
    schemaVersion: 1,
    id: 'memory_1',
    personaId: 'jim',
    kind: 'semantic',
    scope: 'persona',
    status: 'active',
    content: 'The release must preserve workspace isolation.',
    confidence: 1,
    importance: 1,
    sourceRefs: [{ kind: 'user_statement', id: 'statement_1' }],
    trust: 'explicit_user',
    createdAt: 2,
    updatedAt: 2,
  }],
  workItems: [],
  activities: [],
  mailboxItems: [],
  lease: null,
  runtime: {
    projection: {
      personaId: 'jim',
      lifecycleState: 'idle',
      mailbox: { queued: 0, ready: 0, delayed: 0, claimed: 0, coalesced: 0, completed: 0, rejected: 0 },
      activities: { running: 0, waiting: 0, terminal: 0 },
      active: null,
      waitingActivityIds: [],
      leaseStatus: 'none',
      stuck: false,
      stuckIndicators: [],
    },
    detectedStuckIndicators: [],
    reconciliation: { attempted: false, changed: false, remainingStuck: false },
    recentEvents: [],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue([persona]);
  getMock.mockResolvedValue(detail);
  rolesMock.mockResolvedValue({ roleDefinitions: [], roleVersions: [detail.roleVersion] });
  window.history.replaceState({}, '', '/personas/jim');
});

it('exposes the complete Phase 5 desk areas and inspectable revision/memory evidence', async () => {
  render(<PersonasDesk initialPersonaId="jim" />);

  expect(await screen.findByRole('heading', { name: 'Jim' })).toBeInTheDocument();
  expect(screen.getByText('Current Activity')).toBeInTheDocument();
  expect(screen.getAllByRole('tab')).toHaveLength(8);

  fireEvent.click(screen.getByRole('tab', { name: /Memory/i }));
  expect(await screen.findByText('The release must preserve workspace isolation.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Unpin from core' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /Behaviors/i }));
  expect(await screen.findByText('Reviewed override')).toBeInTheDocument();
  expect(screen.getAllByText('Role default')).not.toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Rollback' })).toBeInTheDocument();

  await waitFor(() => expect(replaceMock).toHaveBeenCalled());
});
