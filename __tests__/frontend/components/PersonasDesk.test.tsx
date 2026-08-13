/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const listMock = jest.fn();
const getMock = jest.fn();
const rolesMock = jest.fn();
const replaceMock = jest.fn();
const pushMock = jest.fn();
const grantAppMock = jest.fn();
const revokeAppMock = jest.fn();
const authorizeAppLaunchMock = jest.fn();
const emitLaunchGlobalMcpAppMock = jest.fn();
const discoveryRefreshMock = jest.fn();
const recoverRuntimeMock = jest.fn();

const mockDiscoveryState = {
  servers: [
    {
      name: 'github-jim',
      apps: [{
        serverName: 'github-jim',
        uri: 'ui://github/dashboard',
        name: 'GitHub Dashboard',
        mimeType: 'text/html;profile=mcp-app',
        toolNames: ['list_issues'],
        listedResource: true,
      }],
    },
    { name: 'github-sarah', apps: [] },
  ],
  apps: [],
  loading: false,
  refreshing: false,
  error: null,
  serverErrors: [],
  discoveryId: 1,
  refresh: discoveryRefreshMock,
};

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
    unpinMemoryFromCore: jest.fn(),
    createWorkItem: jest.fn(),
    updateWorkItem: jest.fn(),
    deleteWorkItem: jest.fn(),
    assignWorkItem: jest.fn(),
    activateBehavior: jest.fn(),
    grantApp: (...args: unknown[]) => grantAppMock(...args),
    revokeApp: (...args: unknown[]) => revokeAppMock(...args),
    authorizeAppLaunch: (...args: unknown[]) => authorizeAppLaunchMock(...args),
    recoverRuntime: (...args: unknown[]) => recoverRuntimeMock(...args),
  },
}));

jest.mock('@/frontend/components/mcp/useMcpAppsDiscovery', () => ({
  useMcpAppsDiscovery: () => mockDiscoveryState,
}));

jest.mock('@/frontend/utils/quickActions', () => ({
  emitLaunchGlobalMcpApp: (...args: unknown[]) => emitLaunchGlobalMcpAppMock(...args),
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
  appGrants: [{
    schemaVersion: 1,
    id: 'appgrant_jim',
    personaId: 'jim',
    mcpServerName: 'github-jim',
    createdAt: 4,
    updatedAt: 4,
  }],
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
  presentation: {
    conversations: [],
    tasks: [],
    history: [],
    current: null,
    queuedInputCount: 0,
  },
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

const stuckDetail = {
  ...detail,
  runtime: {
    ...detail.runtime,
    projection: {
      ...detail.runtime.projection,
      leaseStatus: 'expired',
      stuck: true,
      stuckIndicators: ['expired_lease'],
    },
    detectedStuckIndicators: ['expired_lease'],
    reconciliation: { attempted: true, changed: false, remainingStuck: true },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue([persona]);
  getMock.mockResolvedValue(detail);
  rolesMock.mockResolvedValue({ roleDefinitions: [], roleVersions: [detail.roleVersion] });
  grantAppMock.mockResolvedValue(detail.appGrants[0]);
  revokeAppMock.mockResolvedValue(undefined);
  recoverRuntimeMock.mockResolvedValue(detail.runtime);
  authorizeAppLaunchMock.mockResolvedValue({
    personaId: 'jim',
    grantId: 'appgrant_jim',
    mcpServerName: 'github-jim',
    uri: 'ui://github/dashboard',
  });
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

  expect(screen.getByRole('tab', { name: /Behaviors/i })).toBeInTheDocument();

  await waitFor(() => expect(replaceMock).toHaveBeenCalled());
});

it('shows recovery only for actionable stuck state and keeps Call unavailable', async () => {
  render(<PersonasDesk initialPersonaId="jim" />);
  expect(await screen.findByRole('heading', { name: 'Jim' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Repair runtime projection' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /call/i })).not.toBeInTheDocument();
});

it('shows runtime evidence and refreshes after recovery', async () => {
  getMock.mockResolvedValue(stuckDetail);
  render(<PersonasDesk initialPersonaId="jim" />);

  expect(await screen.findByText('The runtime projection needs attention.')).toBeInTheDocument();
  expect(screen.getByText('expired_lease')).toBeInTheDocument();
  expect(screen.getByText(/Lease: expired/)).toBeInTheDocument();
  expect(screen.getByText(/Reconciliation attempted: yes/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Repair runtime projection' }));
  await waitFor(() => expect(recoverRuntimeMock).toHaveBeenCalledWith('jim'));
});

it('prevents duplicate recovery clicks while pending and surfaces backend failures', async () => {
  getMock.mockResolvedValue(stuckDetail);
  let resolveRecovery!: (value: unknown) => void;
  recoverRuntimeMock.mockReturnValueOnce(new Promise((resolve) => {
    resolveRecovery = resolve;
  }));
  render(<PersonasDesk initialPersonaId="jim" />);

  const button = await screen.findByRole('button', { name: 'Repair runtime projection' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(recoverRuntimeMock).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  resolveRecovery(stuckDetail.runtime);
  await waitFor(() => expect(button).not.toBeDisabled());

  recoverRuntimeMock.mockRejectedValueOnce(new Error('Runtime recovery failed'));
  fireEvent.click(button);
  await waitFor(() => expect(recoverRuntimeMock).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('Runtime recovery failed')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Repair runtime projection' })).toBeInTheDocument();
});

it('shows exact account identity and launches only through a grant-scoped descriptor', async () => {
  render(<PersonasDesk initialPersonaId="jim" />);
  expect(await screen.findByRole('heading', { name: 'Jim' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /Apps/i }));
  expect(await screen.findByText('Account / MCP config')).toBeInTheDocument();
  expect(screen.getByText('github-jim')).toBeInTheDocument();
  expect(screen.getByText('GitHub Dashboard')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(authorizeAppLaunchMock).toHaveBeenCalledWith(
    'jim',
    'appgrant_jim',
    'ui://github/dashboard',
  ));
  expect(emitLaunchGlobalMcpAppMock).toHaveBeenCalledWith({
    serverName: 'github-jim',
    uri: 'ui://github/dashboard',
  });
  expect(screen.getByText(/never add tools or permissions/i)).toBeInTheDocument();
});
