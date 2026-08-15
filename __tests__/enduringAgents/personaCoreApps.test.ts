const connectServerMock = jest.fn();
const listServerToolsMock = jest.fn();
const loadServerConfigsMock = jest.fn();
const getPersonaMock = jest.fn();
const getPersonaDeletionTombstoneMock = jest.fn();
const listPersonaAppGrantsMock = jest.fn();

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    connectServer: (...args: unknown[]) => connectServerMock(...args),
    listServerTools: (...args: unknown[]) => listServerToolsMock(...args),
  },
}));

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...args),
}));

jest.mock('@/backend/services/enduringAgents/store', () => ({
  getPersona: (...args: unknown[]) => getPersonaMock(...args),
  getPersonaDeletionTombstone: (...args: unknown[]) => (
    getPersonaDeletionTombstoneMock(...args)
  ),
  listPersonaAppGrants: (...args: unknown[]) => listPersonaAppGrantsMock(...args),
}));

import {
  personaCoreAppNodeId,
  projectPersonaCoreAppsIntoFlow,
  resolveAvailablePersonaAppRefs,
} from '@/backend/services/enduringAgents/personaCoreApps';
import { hashBehaviorFlow } from '@/backend/services/enduringAgents/behaviorRevisions';
import type { Flow } from '@/shared/types/flow';

const PERSONA_ID = 'persona_core_apps_test';
const COMPUTER = 'personal-computer';
const BROWSER = 'browser';

function appConfig(name: string, enableMcpApps = true) {
  return {
    name,
    transport: 'stdio',
    command: 'node',
    args: [],
    disabled: false,
    enableMcpApps,
    rootPath: '',
    env: {},
    _buildCommand: '',
    _installCommand: '',
  };
}

function sourceFlow(): Flow {
  return {
    id: 'flow_persona_core_apps',
    name: 'Persona Core Apps',
    nodes: [
      {
        id: 'start',
        type: 'start',
        position: { x: 0, y: 0 },
        data: { label: 'Start', type: 'start', properties: {} },
      },
      {
        id: 'process-authored',
        type: 'process',
        position: { x: 200, y: 0 },
        data: { label: 'Authored', type: 'process', properties: { boundModel: 'model' } },
      },
      {
        id: 'process-projected',
        type: 'process',
        position: { x: 200, y: 160 },
        data: {
          label: 'Projected',
          type: 'process',
          properties: {
            boundModel: 'model',
            // Legacy derived data is preserved but must not suppress the exact
            // runtime-authorized projection for the same server.
            mcpNodes: [{
              id: 'legacy-stale-computer',
              properties: { boundServer: COMPUTER, enabledTools: ['legacy_only'] },
            }],
          },
        },
      },
      {
        id: 'authored-computer',
        type: 'mcp',
        position: { x: 500, y: 0 },
        data: {
          label: 'Authored computer',
          type: 'mcp',
          properties: {
            boundServer: COMPUTER,
            enabledTools: ['computer_list'],
          },
        },
      },
      {
        id: 'finish',
        type: 'finish',
        position: { x: 700, y: 80 },
        data: { label: 'Finish', type: 'finish', properties: {} },
      },
    ],
    edges: [
      { id: 'start-authored', source: 'start', target: 'process-authored', data: { edgeType: 'standard' } },
      { id: 'authored-finish', source: 'process-authored', target: 'finish', data: { edgeType: 'standard' } },
      { id: 'start-projected', source: 'start', target: 'process-projected', data: { edgeType: 'standard' } },
      { id: 'projected-finish', source: 'process-projected', target: 'finish', data: { edgeType: 'standard' } },
      // Reverse direction deliberately: MCP attachment semantics accept either direction.
      { id: 'computer-authored', source: 'authored-computer', target: 'process-authored', data: { edgeType: 'mcp' } },
    ],
  } as Flow;
}

function projectedBindings(flow: Flow, processId: string) {
  const node = flow.nodes.find((candidate) => candidate.id === processId);
  return (node?.data.properties?.mcpNodes ?? []) as Array<{
    id: string;
    properties: { boundServer?: string; enabledTools?: string[]; enabledResources?: string[] | 'all' };
  }>;
}

describe('Persona Core App flow projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPersonaMock.mockResolvedValue({
      id: PERSONA_ID,
      composition: { appRefs: [COMPUTER, BROWSER] },
    });
    getPersonaDeletionTombstoneMock.mockResolvedValue(null);
    listPersonaAppGrantsMock.mockResolvedValue([]);
    loadServerConfigsMock.mockResolvedValue([appConfig(COMPUTER, false), appConfig(BROWSER)]);
    connectServerMock.mockResolvedValue({ success: true });
    listServerToolsMock.mockImplementation(async (serverName: string) => ({
      tools: serverName === COMPUTER
        ? [{ name: 'sandbox_exec' }, { name: 'computer_list' }, { name: 'sandbox_exec' }]
        : [{ name: 'browser_use' }, { name: 'browser_use' }],
    }));
  });

  it('deduplicates discovery and lets authored MCP wiring win only on its Process', async () => {
    const source = sourceFlow();
    const untouched = structuredClone(source);
    const frozenRefs = [COMPUTER, COMPUTER, BROWSER];

    const projected = await projectPersonaCoreAppsIntoFlow(PERSONA_ID, frozenRefs, source);

    expect(hashBehaviorFlow(projected)).toBe(hashBehaviorFlow(source));

    expect(connectServerMock.mock.calls.map(([serverName]) => serverName)).toEqual([
      COMPUTER,
      BROWSER,
    ]);
    expect(listServerToolsMock.mock.calls.map(([serverName]) => serverName)).toEqual([
      COMPUTER,
      BROWSER,
    ]);

    expect(projectedBindings(projected, 'process-authored')).toEqual([{
      id: personaCoreAppNodeId(BROWSER),
      properties: {
        boundServer: BROWSER,
        enabledTools: ['browser_use'],
        enabledResources: 'all',
      },
    }]);
    expect(projectedBindings(projected, 'process-projected')).toEqual([
      {
        id: 'legacy-stale-computer',
        properties: {
          boundServer: COMPUTER,
          enabledTools: ['legacy_only'],
        },
      },
      {
        id: personaCoreAppNodeId(COMPUTER),
        properties: {
          boundServer: COMPUTER,
          enabledTools: ['sandbox_exec', 'computer_list'],
          enabledResources: 'all',
        },
      },
      {
        id: personaCoreAppNodeId(BROWSER),
        properties: {
          boundServer: BROWSER,
          enabledTools: ['browser_use'],
          enabledResources: 'all',
        },
      },
    ]);
    expect(source).toEqual(untouched);

    const projectedAgain = await projectPersonaCoreAppsIntoFlow(
      PERSONA_ID,
      frozenRefs,
      projected,
    );
    expect(projectedAgain).toEqual(projected);
    expect(source).toEqual(untouched);
  });

  it('retains enabled tool-only MCP servers in Persona selections', async () => {
    loadServerConfigsMock.mockResolvedValue([
      appConfig('tools-only', false),
      { ...appConfig('disabled-tools', false), disabled: true },
    ]);

    await expect(resolveAvailablePersonaAppRefs([
      'tools-only',
      'disabled-tools',
      'missing',
    ])).resolves.toEqual(['tools-only']);
  });
});
