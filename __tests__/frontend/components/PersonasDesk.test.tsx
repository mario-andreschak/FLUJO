/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const listMock = jest.fn();
const getMock = jest.fn();
const rolesMock = jest.fn();
const replaceMock = jest.fn();
const pushMock = jest.fn();
const grantAppMock = jest.fn();
const configureAppMock = jest.fn();
const revokeAppMock = jest.fn();
const authorizeAppLaunchMock = jest.fn();
const emitLaunchGlobalMcpAppMock = jest.fn();
const discoveryRefreshMock = jest.fn();
const recoverRuntimeMock = jest.fn();
const executionPreviewMock = jest.fn();
const createWorkItemMock = jest.fn();
const getWorkItemMock = jest.fn();
const assignWorkItemMock = jest.fn();
const controlWorkItemMock = jest.fn();

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
    createWorkItem: (...args: unknown[]) => createWorkItemMock(...args),
    getWorkItem: (...args: unknown[]) => getWorkItemMock(...args),
    updateWorkItem: jest.fn(),
    deleteWorkItem: jest.fn(),
    assignWorkItem: (...args: unknown[]) => assignWorkItemMock(...args),
    controlWorkItem: (...args: unknown[]) => controlWorkItemMock(...args),
    activateBehavior: jest.fn(),
    grantApp: (...args: unknown[]) => grantAppMock(...args),
    configureApp: (...args: unknown[]) => configureAppMock(...args),
    revokeApp: (...args: unknown[]) => revokeAppMock(...args),
    authorizeAppLaunch: (...args: unknown[]) => authorizeAppLaunchMock(...args),
    recoverRuntime: (...args: unknown[]) => recoverRuntimeMock(...args),
    executionPreview: (...args: unknown[]) => executionPreviewMock(...args),
  },
}));

jest.mock('@/frontend/components/mcp/useMcpAppsDiscovery', () => ({
  useMcpAppsDiscovery: () => mockDiscoveryState,
}));

jest.mock('@/frontend/hooks/useServerTools', () => ({
  useServerTools: (serverName: string | null) => ({
    tools: serverName ? [
      {
        name: 'list_issues',
        title: 'List issues',
        description: 'List repository issues.',
        inputSchema: {
          type: 'object',
          properties: { owner: { type: 'string', description: 'Repository owner.' } },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'delete_issue',
        title: 'Delete issue',
        description: 'Delete an issue.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ] : [],
    toolsServerName: serverName,
    isLoading: false,
    error: null,
    retryLoadTools: jest.fn(),
  }),
}));

jest.mock('@/frontend/components/shared/GlobalReferenceEditor', () => ({
  __esModule: true,
  default: ({
    value,
    onChange,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <input
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

jest.mock('@/frontend/utils/quickActions', () => ({
  emitLaunchGlobalMcpApp: (...args: unknown[]) => emitLaunchGlobalMcpAppMock(...args),
}));

import PersonasDesk from '@/frontend/components/Personas';
import PersonaGoalDialog from '@/frontend/components/Personas/PersonaGoalDialog';

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
  configureAppMock.mockResolvedValue({
    ...detail.appGrants[0],
    enabledTools: ['list_issues'],
    toolParameterPresets: { list_issues: { owner: '@app.name' } },
    updatedAt: 5,
  });
  revokeAppMock.mockResolvedValue(undefined);
  recoverRuntimeMock.mockResolvedValue(detail.runtime);
  executionPreviewMock.mockResolvedValue({
    personaId: 'jim',
    apps: ['github-jim'],
    behaviors: [],
    nativeAbilities: [],
    readOnly: true,
  });
  createWorkItemMock.mockResolvedValue({
    id: 'work_goal',
    personaId: 'jim',
    title: 'Prepare the launch plan',
    status: 'open',
    priority: 'normal',
    dependencyIds: [],
    createdAt: 30,
    updatedAt: 31,
  });
  assignWorkItemMock.mockResolvedValue({ admission: 'queued' });
  getWorkItemMock.mockRejectedValue(new Error('Task not found'));
  controlWorkItemMock.mockResolvedValue({ admission: 'queued' });
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
  expect(screen.getByText('Working now')).toBeInTheDocument();
  expect(screen.getAllByRole('tab')).toHaveLength(10);

  fireEvent.click(screen.getByRole('tab', { name: /Memory/i }));
  expect(await screen.findByText('The release must preserve workspace isolation.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Unpin from core' })).toBeInTheDocument();

  expect(screen.getByRole('tab', { name: /Behaviors/i })).toBeInTheDocument();

  await waitFor(() => expect(replaceMock).toHaveBeenCalled());
});

it('shows recovery only for actionable stuck state and keeps Call unavailable', async () => {
  render(<PersonasDesk initialPersonaId="jim" />);
  expect(await screen.findByRole('heading', { name: 'Jim' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Repair and continue' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /call/i })).not.toBeInTheDocument();
});

it('shows runtime evidence and refreshes after recovery', async () => {
  getMock.mockResolvedValue(stuckDetail);
  render(<PersonasDesk initialPersonaId="jim" />);

  expect(await screen.findByText('Saved work needs attention.')).toBeInTheDocument();
  expect(screen.getByText('expired_lease')).toBeInTheDocument();
  expect(screen.getByText('Status: stalled. 0 task(s) ready, 0 waiting.')).toBeInTheDocument();
  expect(screen.queryByText(/Lease: expired/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Mailbox:/)).not.toBeInTheDocument();
  expect(screen.getByText(/Reconciliation attempted: yes/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Repair and continue' }));
  await waitFor(() => expect(recoverRuntimeMock).toHaveBeenCalledWith('jim'));
});

it('prevents duplicate recovery clicks while pending and surfaces backend failures', async () => {
  getMock.mockResolvedValue(stuckDetail);
  let resolveRecovery!: (value: unknown) => void;
  recoverRuntimeMock.mockReturnValueOnce(new Promise((resolve) => {
    resolveRecovery = resolve;
  }));
  render(<PersonasDesk initialPersonaId="jim" />);

  const button = await screen.findByRole('button', { name: 'Repair and continue' });
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
  expect(screen.getByRole('button', { name: 'Repair and continue' })).toBeInTheDocument();
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

it('configures Persona Core tools and @-aware fixed parameters on a grant', async () => {
  render(<PersonasDesk initialPersonaId="jim" />);
  expect(await screen.findByRole('heading', { name: 'Jim' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /Apps/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'Configure tools' }));
  expect(await screen.findByRole('heading', { name: 'Tools for github-jim' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle Delete issue' }));
  fireEvent.click(screen.getByRole('button', {
    name: /Fixed parameters for List issues Configure values hidden from the model/,
  }));
  fireEvent.click(screen.getByRole('checkbox', { name: /owner/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Fixed value for list_issues.owner' }), {
    target: { value: '@app.name' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(configureAppMock).toHaveBeenCalledWith(
    'jim',
    'appgrant_jim',
    {
      mcpServerName: 'github-jim',
      enabledTools: ['list_issues'],
      toolParameterPresets: { list_issues: { owner: '@app.name' } },
      expectedUpdatedAt: 4,
    },
  ));
});

it('keeps the one-shot option as durable work and assigns it only after creation', async () => {
  let resolveCreate!: (value: unknown) => void;
  createWorkItemMock.mockReturnValueOnce(new Promise((resolve) => {
    resolveCreate = resolve;
  }));
  render(<PersonasDesk initialPersonaId="jim" />);

  expect(await screen.findByRole('heading', { name: 'Jim' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Give this Persona a goal' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep working on this goal' }));
  fireEvent.change(await screen.findByRole('textbox', { name: /Goal/ }), {
    target: { value: '  Prepare the launch plan  ' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Helpful context (optional)' }), {
    target: { value: '  Include approvals and owners.  ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start working' }));

  await waitFor(() => expect(createWorkItemMock).toHaveBeenCalledWith('jim', {
    id: expect.stringMatching(/^work_/),
    title: 'Prepare the launch plan',
    description: 'Include approvals and owners.',
    priority: 'normal',
    dependencyIds: [],
  }));
  expect(assignWorkItemMock).not.toHaveBeenCalled();

  expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Starting…' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Creation could not be confirmed/)).not.toBeInTheDocument();

  resolveCreate({
    id: 'work_goal',
    personaId: 'jim',
    title: 'Prepare the launch plan',
    status: 'open',
    priority: 'normal',
    dependencyIds: [],
    createdAt: 30,
    updatedAt: 31,
  });

  await waitFor(() => expect(assignWorkItemMock).toHaveBeenCalledWith(
    'jim',
    'work_goal',
    {
      expectedUpdatedAt: 31,
      idempotencyKey: expect.any(String),
    },
  ));
  expect(await screen.findByText(/Goal saved and queued/)).toBeInTheDocument();
});

it('starts ongoing ownership by default without issuing a competing assignment', async () => {
  render(<PersonasDesk initialPersonaId="jim" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Give this Persona a goal' }));
  expect(screen.getByRole('checkbox', { name: 'Keep working on this goal' })).toBeChecked();
  fireEvent.change(screen.getByRole('textbox', { name: /^Goal/ }), { target: { value: 'Make FLUJO known on the internet' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start working' }));
  await waitFor(() => expect(createWorkItemMock).toHaveBeenCalledWith('jim', expect.objectContaining({
    id: expect.stringMatching(/^work_/),
    goal: { successCriteria: expect.stringContaining('Completing one task does not complete'), completionPolicy: 'until_stopped', continuationIntervalMs: 60_000 },
  })));
  expect(await screen.findByText(/Goal saved\. This Persona will keep working/)).toBeInTheDocument();
  expect(assignWorkItemMock).not.toHaveBeenCalled();
});

it('does not present the next queued task as already working', async () => {
  getMock.mockResolvedValue({
    ...detail,
    presentation: { ...detail.presentation, tasks: [{
      id: 'next_child', title: 'Publish the next article', state: 'waiting',
      priority: 'normal', blockerTitles: [], expectedUpdatedAt: 10,
    }] },
  });
  render(<PersonasDesk initialPersonaId="jim" />);
  expect(await screen.findByText('This Persona is idle and ready for work.')).toBeInTheDocument();
  expect(screen.getAllByText('Publish the next article')).toHaveLength(1);
});

it('freezes an uncertain creation across attempted edits and reopening, then recovers the original id', async () => {
  createWorkItemMock.mockRejectedValueOnce(new Error('Connection lost'));
  render(<PersonasDesk initialPersonaId="jim" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Give this Persona a goal' }));
  fireEvent.change(screen.getByRole('textbox', { name: /^Goal/ }), { target: { value: 'Build an audience' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start working' }));
  expect(await screen.findByText('Connection lost')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: /^Goal/ })).toHaveValue('Build an audience');
  expect(screen.getByRole('textbox', { name: /^Goal/ })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Success criteria (optional)' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Keep working on this goal' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: /^Goal/ }), { target: { value: 'A different goal' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Success criteria (optional)' }), { target: { value: 'A different finish condition' } });
  expect(screen.getByRole('textbox', { name: /^Goal/ })).toHaveValue('Build an audience');
  expect(screen.getByRole('textbox', { name: 'Success criteria (optional)' })).toHaveValue('');
  const createdInput = createWorkItemMock.mock.calls[0][1];
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Give this Persona a goal' }));
  expect(screen.getByRole('textbox', { name: /^Goal/ })).toHaveValue('Build an audience');
  expect(screen.getByRole('textbox', { name: /^Goal/ })).toBeDisabled();
  getWorkItemMock.mockResolvedValueOnce({ ...createdInput, personaId: 'jim', updatedAt: 31 });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(/Goal saved\. This Persona will keep working/)).toBeInTheDocument();
  expect(createWorkItemMock).toHaveBeenCalledTimes(1);
  expect(getWorkItemMock).toHaveBeenLastCalledWith('jim', createdInput.id);
  expect(assignWorkItemMock).not.toHaveBeenCalled();
});

it('unlocks rejected input for correction when the server definitively refused creation', async () => {
  createWorkItemMock.mockRejectedValueOnce(Object.assign(new Error('Invalid goal'), { status: 400 }));
  render(<PersonasDesk initialPersonaId="jim" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Give this Persona a goal' }));
  fireEvent.change(screen.getByRole('textbox', { name: /^Goal/ }), { target: { value: 'Draft a goal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start working' }));
  expect(await screen.findByText('Invalid goal')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: /^Goal/ })).toBeEnabled();
  expect(getWorkItemMock).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: /^Goal/ }), { target: { value: 'Corrected goal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start working' }));
  expect(await screen.findByText(/Goal saved\. This Persona will keep working/)).toBeInTheDocument();
  expect(createWorkItemMock).toHaveBeenLastCalledWith('jim', expect.objectContaining({ title: 'Corrected goal' }));
});

it('resets the submission guard after an unexpected mutation-wrapper rejection', async () => {
  const onClose = jest.fn();
  const mutation = jest.fn()
    .mockRejectedValueOnce(new Error('Mutation wrapper unavailable'))
    .mockImplementationOnce(async (action: () => Promise<unknown>) => { await action(); return true; });
  render(<PersonaGoalDialog open personaId="jim" busy={false} mutate={mutation} onClose={onClose} />);
  fireEvent.change(screen.getByRole('textbox', { name: /^Goal/ }), { target: { value: 'Build an audience' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start working' }));
  expect(await screen.findByText('Mutation wrapper unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Start working' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(mutation).toHaveBeenCalledTimes(2);
  expect(createWorkItemMock).toHaveBeenCalledTimes(1);
});

it('retries assignment of the saved one-shot task without creating a duplicate', async () => {
  assignWorkItemMock.mockRejectedValueOnce(new Error('Assignment unavailable'));
  render(<PersonasDesk initialPersonaId="jim" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Give this Persona a goal' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Keep working on this goal' }));
  fireEvent.change(screen.getByRole('textbox', { name: /^Goal/ }), { target: { value: 'Prepare launch copy' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start working' }));
  expect(await screen.findByText('Assignment unavailable')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: /^Goal/ })).toHaveValue('Prepare launch copy');
  expect(screen.getByText(/Your task is saved/)).toBeInTheDocument();
  const firstAssignment = assignWorkItemMock.mock.calls[0];
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(/Goal saved and queued/)).toBeInTheDocument();
  expect(createWorkItemMock).toHaveBeenCalledTimes(1);
  expect(assignWorkItemMock).toHaveBeenLastCalledWith(...firstAssignment);
});

it('makes full activity history reachable from the persona tabs', async () => {
  render(<PersonasDesk initialPersonaId="jim" />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Activity history' }));
  expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument();
  expect(replaceMock).toHaveBeenLastCalledWith(expect.stringContaining('area=history'));
});

it('discovers externally started work while the persona detail was idle', async () => {
  render(<PersonasDesk initialPersonaId="jim" />);
  expect(await screen.findByRole('heading', { name: 'Jim' })).toBeInTheDocument();
  getMock.mockResolvedValue({ ...detail, persona: { ...persona, lifecycleState: 'busy' } });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(await screen.findByText('Working', { selector: '.MuiChip-label' })).toBeInTheDocument();
  expect(getMock).toHaveBeenCalledTimes(2);
});

it('shows a blocked task next step and evidence instead of a zero-blocker message', async () => {
  getMock.mockResolvedValue({
    ...detail,
    workItems: [{ id: 'work_blocked', personaId: 'jim', title: 'Publish launch post', status: 'blocked', updatedAt: 44 }],
    presentation: { ...detail.presentation, tasks: [{
      id: 'work_blocked', title: 'Publish launch post', state: 'blocked', priority: 'normal', blockerTitles: [],
      nextAction: 'The posting service is unavailable. A draft is saved for retry.',
      recordLinks: [{ kind: 'conversation', id: 'conversation_blocked' }], expectedUpdatedAt: 44,
    }] },
  });
  render(<PersonasDesk initialPersonaId="jim" />);
  expect(await screen.findByText('The posting service is unavailable. A draft is saved for retry.')).toBeInTheDocument();
  expect(screen.queryByText('Waiting on 0 blocker(s).')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open chat' })).toHaveAttribute('href', expect.stringContaining('conversation_blocked'));
});

it('shows what finished work produced and a plain route back to its record', async () => {
  const workItem = {
    schemaVersion: 1,
    id: 'work_finished',
    personaId: 'jim',
    title: 'Prepare the launch report',
    status: 'completed',
    priority: 'normal',
    dependencyIds: [],
    createdAt: 30,
    updatedAt: 42,
    completedAt: 42,
  };
  getMock.mockResolvedValue({
    ...detail,
    workItems: [workItem],
    presentation: {
      ...detail.presentation,
      tasks: [{
        id: workItem.id,
        title: workItem.title,
        state: 'completed',
        priority: workItem.priority,
        blockerTitles: [],
        completedAt: workItem.completedAt,
        resultSummary: 'The launch report is ready for review.',
        recordLinks: [{ kind: 'conversation', id: 'conversation_result' }],
        expectedUpdatedAt: workItem.updatedAt,
      }],
    },
  });

  render(<PersonasDesk initialPersonaId="jim" />);

  expect(await screen.findByText('The launch report is ready for review.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open chat' }))
    .toHaveAttribute('href', expect.stringContaining('conversation_result'));
});

it('offers Pause and Stop for active work from the Persona desk', async () => {
  const workItem = {
    schemaVersion: 1,
    id: 'work_active',
    personaId: 'jim',
    title: 'Prepare the active launch',
    status: 'open',
    priority: 'high',
    dependencyIds: [],
    createdAt: 30,
    updatedAt: 31,
  };
  getMock.mockResolvedValue({
    ...detail,
    workItems: [workItem],
    presentation: {
      ...detail.presentation,
      tasks: [{
        id: workItem.id,
        title: workItem.title,
        state: 'in_progress',
        priority: workItem.priority,
        blockerTitles: [],
        expectedUpdatedAt: workItem.updatedAt,
      }],
    },
  });
  render(<PersonasDesk initialPersonaId="jim" />);

  expect(await screen.findByText(workItem.title)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(controlWorkItemMock).toHaveBeenCalledWith(
    'jim',
    workItem.id,
    'pause',
  ));
  expect(await screen.findByText('Work paused.')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(controlWorkItemMock).toHaveBeenCalledWith(
    'jim',
    workItem.id,
    'stop',
  ));
  expect(await screen.findByText('Work stopped.')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /Tasks/i }));
  expect(await screen.findByRole('button', { name: 'Delete' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit Task' }));
  expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Priority' })).toBeInTheDocument();
});

it('offers one plain Resume or retry action for paused or failed work', async () => {
  const workItem = {
    schemaVersion: 1,
    id: 'work_blocked',
    personaId: 'jim',
    title: 'Prepare the blocked launch',
    status: 'blocked',
    priority: 'normal',
    dependencyIds: [],
    createdAt: 30,
    updatedAt: 32,
  };
  getMock.mockResolvedValue({
    ...detail,
    workItems: [workItem],
    presentation: {
      ...detail.presentation,
      tasks: [{
        id: workItem.id,
        title: workItem.title,
        state: 'blocked',
        priority: workItem.priority,
        blockerTitles: [],
        expectedUpdatedAt: workItem.updatedAt,
      }],
    },
  });
  render(<PersonasDesk initialPersonaId="jim" />);

  const button = await screen.findByRole('button', { name: 'Resume or retry' });
  fireEvent.click(button);

  await waitFor(() => expect(controlWorkItemMock).toHaveBeenCalledWith(
    'jim',
    workItem.id,
    'retry',
  ));
  expect(await screen.findByText('Work started again.')).toBeInTheDocument();
});

it('moves queued Tasks earlier or later inside the same importance bucket', async () => {
  const workItems = [
    {
      schemaVersion: 1,
      id: 'work_queue_first',
      personaId: 'jim',
      title: 'First queued Task',
      status: 'open',
      priority: 'normal',
      dependencyIds: [],
      createdAt: 30,
      updatedAt: 31,
    },
    {
      schemaVersion: 1,
      id: 'work_queue_second',
      personaId: 'jim',
      title: 'Second queued Task',
      status: 'open',
      priority: 'normal',
      dependencyIds: [],
      createdAt: 32,
      updatedAt: 33,
    },
  ];
  getMock.mockResolvedValue({
    ...detail,
    workItems,
    presentation: {
      ...detail.presentation,
      tasks: workItems.map((item) => ({
        id: item.id,
        title: item.title,
        state: 'waiting',
        priority: item.priority,
        blockerTitles: [],
        expectedUpdatedAt: item.updatedAt,
      })),
    },
  });
  render(<PersonasDesk initialPersonaId="jim" />);

  expect(await screen.findByRole('heading', { name: 'Jim' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: /Tasks/i }));
  const earlier = await screen.findAllByRole('button', { name: 'Move earlier' });
  const later = screen.getAllByRole('button', { name: 'Move later' });
  expect(earlier[0]).toBeDisabled();
  expect(earlier[1]).not.toBeDisabled();
  expect(later[0]).not.toBeDisabled();
  expect(later[1]).toBeDisabled();

  fireEvent.click(later[0]);
  await waitFor(() => expect(controlWorkItemMock).toHaveBeenCalledWith(
    'jim',
    workItems[0].id,
    'move_later',
  ));
  await waitFor(() => expect(earlier[1]).not.toBeDisabled());
  fireEvent.click(earlier[1]);
  await waitFor(() => expect(controlWorkItemMock).toHaveBeenCalledWith(
    'jim',
    workItems[1].id,
    'move_earlier',
  ));
});

it('shows the effective Apps, specialist Behaviors, and native abilities from preview', async () => {
  executionPreviewMock.mockResolvedValueOnce({
    personaId: 'jim',
    coreFlowRef: 'flow_effective_core',
    apps: ['calendar-team'],
    behaviors: [{
      slotKey: 'incident_triage',
      name: 'Incident triage',
      description: 'Investigate and summarize an incident.',
    }],
    nativeAbilities: ['remember', 'work_item_create'],
    readOnly: true,
  });
  render(<PersonasDesk initialPersonaId="jim" />);

  expect(await screen.findByRole('heading', { name: 'Jim' })).toBeInTheDocument();
  await waitFor(() => expect(executionPreviewMock).toHaveBeenCalledWith('jim'));
  expect(await screen.findByText('Can use and organize memory')).toBeInTheDocument();
  expect(screen.getByText('Can create and finish Tasks')).toBeInTheDocument();
  expect(screen.getByText('Some everyday abilities are off. Choose Change setup to turn memory, Tasks, or improvements on.')).toBeInTheDocument();
  expect(screen.getByText('calendar-team')).toBeInTheDocument();
  expect(screen.getByText('Incident triage')).toBeInTheDocument();
  expect(screen.queryByText('github-jim')).not.toBeInTheDocument();
});
