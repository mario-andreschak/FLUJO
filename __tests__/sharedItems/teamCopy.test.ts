/**
 * Copying into a team workspace (#575, step 575-4): the copy carries plain
 * settings and never a key, token, password, sign-in, encrypted value or
 * private folder. Each value left behind is listed, and so is everything the
 * copy needs that the target workspace does not have yet.
 *
 * The flow, model and MCP services are replaced by small in-memory stores per
 * workspace, so these tests exercise exactly the copy rules.
 */

type Store = {
  flows: Array<Record<string, unknown>>;
  models: Array<Record<string, unknown>>;
  servers: Array<Record<string, unknown>>;
  globals: Record<string, unknown>;
};

const stores = new Map<string, Store>();
const emptyStore = (): Store => ({ flows: [], models: [], servers: [], globals: {} });
function here(): Store {
  const { getCurrentWorkspace } = require('@/utils/workspace') as typeof import('@/utils/workspace');
  const name = getCurrentWorkspace();
  if (!stores.has(name)) stores.set(name, emptyStore());
  return stores.get(name)!;
}

jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  ensureWorkspaceDirs: async () => '',
}));
jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: async () => here().globals,
}));
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    getFlow: async (id: string) => structuredClone(here().flows.find(flow => flow.id === id) ?? null),
    loadFlows: async () => structuredClone(here().flows),
    saveFlow: async (flow: Record<string, unknown>) => {
      here().flows.push(structuredClone(flow));
      return { success: true };
    },
  },
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    loadModels: async () => structuredClone(here().models),
    addModel: async (model: Record<string, unknown>) => {
      here().models.push(structuredClone(model));
      return { success: true, model };
    },
  },
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: async () => structuredClone(here().servers),
    updateServerConfig: async (_name: string, config: Record<string, unknown>) => {
      here().servers.push(structuredClone(config));
      return config;
    },
  },
}));
jest.mock('@/backend/services/sharedItems/load', () => ({ loadSharedItem: async () => ({ id: 'loaded' }) }));
jest.mock('@/backend/services/sharedItems/guard', () => ({
  ...jest.requireActual('@/backend/services/sharedItems/guard'),
  recordChange: jest.fn(async () => null),
}));
jest.mock('@/backend/services/accounts/store', () => ({
  ...jest.requireActual('@/backend/services/accounts/store'),
  appendAudit: jest.fn(async () => undefined),
}));

import path from 'node:path';
import { getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import { appendAudit } from '@/backend/services/accounts/store';
import { recordChange, type SharedEditor } from '@/backend/services/sharedItems/guard';
import { isSecretKey } from '@/backend/services/sharedItems/secrets';
import {
  FLOW_FIELDS, MCP_FIELDS, MODEL_FIELDS, TeamCopyError, copySharedItem, type TeamCopyResult,
} from '@/backend/services/sharedItems/teamCopy';

const SECRET = 'sk-live-THIS-MUST-NEVER-BE-COPIED';
const ENCRYPTED = 'encrypted:v2:00ff:11ee:c2VjcmV0';

const editor = {
  user: { id: 'u_anna000000000000000', displayName: 'Anna' },
  workspace: 'anna-ws',
  generation: 0,
  accounts: {},
} as unknown as SharedEditor;

function copy(kind: 'flow' | 'model' | 'mcp-server', id: string, target = 'sales-ws'): Promise<TeamCopyResult> {
  return runWithWorkspace('anna-ws', () => copySharedItem({ kind, id, targetWorkspace: target, editor }));
}

function saved(kind: 'flows' | 'models' | 'servers', workspace = 'sales-ws'): Array<Record<string, unknown>> {
  return stores.get(workspace)?.[kind] ?? [];
}

function noSecretsIn(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('encrypted:');
}

beforeEach(() => {
  stores.clear();
  stores.set('anna-ws', emptyStore());
  stores.set('sales-ws', emptyStore());
  jest.mocked(recordChange).mockClear();
  jest.mocked(appendAudit).mockClear();
});

describe('the field lists', () => {
  it('never copy a secret-looking field as it is', () => {
    for (const rules of [MODEL_FIELDS, MCP_FIELDS, FLOW_FIELDS] as Array<Record<string, string>>) {
      for (const [field, rule] of Object.entries(rules)) {
        if (isSecretKey(field)) expect([field, rule]).not.toEqual([field, 'copy']);
      }
    }
    expect(MODEL_FIELDS.ownerCredentialBinding).toBe('drop');
    expect(MCP_FIELDS.oauthTokens).toBe('drop');
    expect(MCP_FIELDS.rootPath).toBe('drop');
    expect(MCP_FIELDS.hostPathAccess).toBe('drop');
    expect(MCP_FIELDS.trustedHost).toBe('drop');
    expect(FLOW_FIELDS.personaOwnership).toBe('drop');
  });
});

describe('copying a model', () => {
  it('keeps the settings, leaves the key behind and says so', async () => {
    stores.get('anna-ws')!.models.push({
      id: 'm1', name: 'gpt-x', displayName: 'Writer', provider: 'openai', temperature: '0.3', maxTokens: 2000,
      ApiKey: ENCRYPTED, baseUrl: `https://bob:${SECRET}@api.example.com/v1?api-key=${SECRET}&region=eu`,
      ownerCredentialBinding: { ownerId: 'owner', credentialId: 'cred' }, credentialSourceId: 'm0',
    });
    const result = await copy('model', 'm1');
    const [model] = saved('models');
    expect(model).toMatchObject({ id: 'm1', name: 'gpt-x', displayName: 'Writer', provider: 'openai', temperature: '0.3', maxTokens: 2000, ApiKey: '' });
    expect(model.ownerCredentialBinding).toBeUndefined();
    expect(model.credentialSourceId).toBeUndefined();
    expect(model.baseUrl).toBe('https://api.example.com/v1?region=eu');
    noSecretsIn(model);
    noSecretsIn(result);
    expect(result.missingValues.map(item => item.field)).toEqual(expect.arrayContaining(['API key', 'Base address', 'Sign-in of the model']));
    expect(result.copied).toEqual({ kind: 'model', id: 'm1', name: 'Writer' });
  });

  it('keeps a workspace variable reference and lists the variable when the team lacks it', async () => {
    stores.get('anna-ws')!.models.push({ id: 'm2', name: 'gpt-x', displayName: 'Global', provider: 'openai', ApiKey: '${global:OPENAI_KEY}' });
    const result = await copy('model', 'm2');
    expect(saved('models')[0].ApiKey).toBe('${global:OPENAI_KEY}');
    expect(result.missingValues).toEqual([expect.objectContaining({ field: 'Workspace variable OPENAI_KEY' })]);

    stores.get('sales-ws')!.globals = { OPENAI_KEY: { value: 'encrypted:x', metadata: { isSecret: true } } };
    const again = await copy('model', 'm2');
    expect(again.missingValues).toEqual([]);
  });

  it('gives the copy a new id and name when the team already has them', async () => {
    stores.get('anna-ws')!.models.push({ id: 'm1', name: 'gpt-x', displayName: 'Writer', provider: 'openai', ApiKey: '' });
    stores.get('sales-ws')!.models.push({ id: 'm1', name: 'other', displayName: 'writer', provider: 'openai', ApiKey: '' });
    const result = await copy('model', 'm1');
    expect(result.copied.id).not.toBe('m1');
    expect(result.copied.name).toBe('Writer (copy)');
  });

  it('asks to copy the member models of a fallback policy first', async () => {
    stores.get('anna-ws')!.models.push(
      { id: 'a', name: 'a', displayName: 'First', provider: 'openai', ApiKey: '' },
      { id: 'b', name: 'b', displayName: 'Second', provider: 'openai', ApiKey: '' },
      { id: 'p', name: 'p', displayName: 'Policy', ApiKey: '', fallbackPolicy: { modelIds: ['a', 'b'] } },
    );
    const failure = await copy('model', 'p').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TeamCopyError);
    expect((failure as TeamCopyError).status).toBe(409);
    expect((failure as TeamCopyError).missingDependencies.map(item => item.name)).toEqual(['First', 'Second']);
    expect(saved('models')).toEqual([]);
  });
});

describe('copying an MCP server', () => {
  it('clears secret values, private folders and host grants, and starts turned off', async () => {
    const own = getWorkspaceDataDir('anna-ws');
    stores.get('anna-ws')!.servers.push({
      name: 'github', transport: 'stdio', disabled: false, command: 'node',
      args: [path.join(own, 'mcp-servers', 'github', 'dist', 'index.js'), `--api-key=${SECRET}`, '--token', SECRET, '--verbose'],
      env: {
        GITHUB_TOKEN: { value: ENCRYPTED, metadata: { isSecret: true } },
        LEGACY: SECRET,
        LOG_LEVEL: { value: 'debug', metadata: { isSecret: false } },
        SHARED: '${global:TEAM_TOKEN}',
      },
      rootPath: path.join(own, 'mcp-servers', 'github'), cwd: own, roots: [own],
      hostPathAccess: { environmentRootVariables: ['HOME'], snapshots: true }, trustedHost: { yes: true },
      isolation: { mode: 'host' }, runtimeHomeMode: 'host', exposeAsMcpServer: true,
      _buildCommand: 'npm run build', _installCommand: 'npm ci', folder: 'Dev', enableMcpApps: true,
      toolParameterPresets: { search: { apiKey: SECRET, limit: 5 } },
    });
    const result = await copy('mcp-server', 'github');
    const [server] = saved('servers');
    noSecretsIn(server);
    noSecretsIn(result);
    expect(JSON.stringify(server)).not.toContain(own.replace(/\\/g, '\\\\'));
    expect(server).toMatchObject({
      name: 'github', transport: 'stdio', disabled: true, command: 'node', rootPath: '',
      _buildCommand: 'npm run build', folder: 'Dev', enableMcpApps: true,
      args: ['', '--api-key=', '--token', '', '--verbose'],
      env: {
        GITHUB_TOKEN: { value: '', metadata: { isSecret: true } },
        LEGACY: { value: '', metadata: { isSecret: true } },
        LOG_LEVEL: { value: 'debug', metadata: { isSecret: false } },
        SHARED: '${global:TEAM_TOKEN}',
      },
      toolParameterPresets: { search: { apiKey: '', limit: 5 } },
    });
    for (const dropped of ['cwd', 'roots', 'hostPathAccess', 'trustedHost', 'isolation', 'runtimeHomeMode', 'exposeAsMcpServer']) {
      expect(server[dropped]).toBeUndefined();
    }
    expect(result.missingValues.map(item => item.field)).toEqual(expect.arrayContaining([
      'Environment variable GITHUB_TOKEN', 'Environment variable LEGACY', 'Workspace variable TEAM_TOKEN',
      'Program argument --api-key', 'Program argument --token',
    ]));
  });

  it('drops sign-in state and secret headers of a remote server', async () => {
    stores.get('anna-ws')!.servers.push({
      name: 'remote', transport: 'streamable', disabled: false, rootPath: '', env: {}, _buildCommand: '', _installCommand: '',
      serverUrl: `https://mcp.example.com/mcp?token=${SECRET}`,
      headers: { Authorization: { value: ENCRYPTED, metadata: { isSecret: true } }, 'X-Region': { value: 'eu', metadata: { isSecret: false } } },
      oauthClientId: 'client-1', oauthClientSecret: ENCRYPTED, oauthScopes: ['read'],
      oauthTokens: { format: 'flujo-oauth-v1', ciphertext: SECRET }, oauthClientInformation: { client_secret: SECRET },
      oauthCodeVerifier: SECRET, oauthState: SECRET, authorizationUrl: `https://auth.example.com/?state=${SECRET}`,
    });
    stores.get('sales-ws')!.servers.push({ name: 'remote', transport: 'stdio' });
    const result = await copy('mcp-server', 'remote');
    const server = saved('servers').find(item => item.name === 'remote-copy')!;
    noSecretsIn(server);
    expect(server).toMatchObject({
      serverUrl: 'https://mcp.example.com/mcp', oauthClientId: 'client-1', oauthScopes: ['read'], disabled: true,
      headers: { Authorization: { value: '', metadata: { isSecret: true } }, 'X-Region': { value: 'eu', metadata: { isSecret: false } } },
    });
    for (const dropped of ['oauthClientSecret', 'oauthTokens', 'oauthClientInformation', 'oauthCodeVerifier', 'oauthState', 'authorizationUrl']) {
      expect(server[dropped]).toBeUndefined();
    }
    expect(result.copied.name).toBe('remote-copy');
    expect(result.missingValues.map(item => item.field)).toEqual(expect.arrayContaining(['Header Authorization', 'OAuth client secret', 'OAuth sign-in', 'Server address']));
  });
});

describe('copying a flow', () => {
  const flow = {
    id: 'f1', name: 'Support', description: 'Answers mail', createdAt: 1, updatedAt: 2,
    personaOwnership: { personaId: 'p1' },
    executionDependencies: { schemaVersion: 1, workspaceId: 'anna-ws', flows: [] },
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    nodes: [
      { id: 'n1', type: 'process', position: { x: 0, y: 0 }, data: { label: 'Think', type: 'process',
        properties: { boundModel: 'm1', promptTemplate: 'Be kind', apiKey: SECRET, extra: ENCRYPTED } } },
      { id: 'n2', type: 'mcp', position: { x: 1, y: 0 }, data: { label: 'Tools', type: 'mcp',
        properties: { boundServer: 'github', env: { TOKEN: { value: SECRET, metadata: { isSecret: true } } } } } },
      { id: 'n3', type: 'subflow', position: { x: 2, y: 0 }, data: { label: 'Child', type: 'subflow', properties: { flowId: 'f2' } } },
    ],
  };

  it('copies the steps without secrets and lists what the team still needs', async () => {
    stores.get('anna-ws')!.flows.push(structuredClone(flow), { id: 'f2', name: 'Child flow', nodes: [], edges: [] });
    stores.get('anna-ws')!.models.push({ id: 'm1', name: 'gpt-x', displayName: 'Writer', ApiKey: SECRET });
    const result = await copy('flow', 'f1');
    const [copied] = saved('flows');
    noSecretsIn(copied);
    noSecretsIn(result);
    expect(copied).toMatchObject({ id: 'f1', name: 'Support', description: 'Answers mail', edges: flow.edges });
    for (const dropped of ['personaOwnership', 'executionDependencies', 'createdAt', 'updatedAt']) expect(copied[dropped]).toBeUndefined();
    const properties = (copied.nodes as Array<{ data: { properties: Record<string, unknown> } }>)[0].data.properties;
    expect(properties).toMatchObject({ boundModel: 'm1', promptTemplate: 'Be kind', apiKey: '', extra: '' });
    expect(result.missingDependencies).toEqual(expect.arrayContaining([
      { kind: 'model', id: 'm1', name: 'Writer' },
      { kind: 'mcp-server', id: 'github', name: 'github' },
      { kind: 'flow', id: 'f2', name: 'Child flow' },
    ]));
    expect(result.missingValues.map(item => item.field)).toEqual(expect.arrayContaining([
      'Step "Think": apiKey', 'Step "Think"', 'Step "Tools": environment variable TOKEN',
    ]));
  });

  it('records who copied it in the team history and the audit log, without secrets', async () => {
    stores.get('anna-ws')!.flows.push(structuredClone(flow));
    stores.get('sales-ws')!.flows.push({ id: 'f1', name: 'support', nodes: [], edges: [] });
    const result = await copy('flow', 'f1');
    expect(result.copied.id).not.toBe('f1');
    expect(result.copied.name).toBe('Support (copy)');
    expect(recordChange).toHaveBeenCalledWith(editor, expect.objectContaining({
      kind: 'flow', itemId: result.copied.id, action: 'copied-in', copiedFrom: { workspace: 'anna-ws', itemId: 'f1' },
    }));
    expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'item-copied', actorUserId: editor.user.id, target: { type: 'workspace', id: 'sales-ws' },
    }));
    noSecretsIn(jest.mocked(appendAudit).mock.calls);
  });

  it('refuses to copy into the same workspace and reports a missing item', async () => {
    await expect(copy('flow', 'f1', 'anna-ws')).rejects.toMatchObject({ status: 400 });
    await expect(copy('flow', 'nope')).rejects.toMatchObject({ status: 404 });
  });
});
