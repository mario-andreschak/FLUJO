import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type { Model } from '@/shared/types/model';
import type { MCPServerConfig } from '@/shared/types/mcp';

const mockBuildPlan = jest.fn((configs, root) => ({ formatVersion: 1, sourceWorkspaceRoot: root, servers: configs }));
const mockSelection = jest.fn((flowIds: string[] | undefined, entities: { mcpServers: MCPServerConfig[]; models: Model[] }) => ({
  configs: entities.mcpServers, flowIds: flowIds ?? [], mcpServerNames: entities.mcpServers.map(server => server.name),
  requiresCodexAuth: entities.models.some(model => (model.adapter === 'codex-cli' || model.provider === 'codex') && !model.ApiKey),
}));
jest.mock('@/backend/services/packages/workspaceMcpTransfer', () => ({
  buildWorkspaceMcpTransferPlan: (configs: unknown, root: string) => mockBuildPlan(configs, root),
  pinWorkspaceMcpTransferPlan: async (plan: unknown) => plan,
  selectWorkspaceFlowDependencies: (...args: Parameters<typeof mockSelection>) => mockSelection(...args),
}));
const mockDek = jest.fn< string | null, []>(() => null);
jest.mock('@/utils/encryption/session', () => ({ getServerDek: () => mockDek() }));

import { captureWorkspaceSnapshot, writeWorkspaceSnapshotArchive } from '@/backend/services/workspace/snapshotArchive';
import { CODEX_AUTH_SOURCE_FILE } from '@/backend/services/model/adapters/codexAuth';

const environmentKeys = ['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'CODEX_HOME', 'FLUJO_SNAPSHOT_MAX_BYTES', 'FLUJO_SNAPSHOT_MAX_FILE_BYTES'] as const;

describe('portable workspace capture', () => {
  let root: string;
  let workspace: string;
  let previous: Array<string | undefined>;

  beforeEach(async () => {
    previous = environmentKeys.map(key => process.env[key]);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-portable-capture-'));
    workspace = path.join(root, 'workspaces', 'research');
    process.env.FLUJO_DATA_DIR = root;
    process.env.CODEX_HOME = path.join(root, 'personal');
    delete process.env.FLUJO_PARENT_DATA_DIR;
    delete process.env.FLUJO_SNAPSHOT_MAX_BYTES;
    delete process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES;
    mockBuildPlan.mockClear();
    mockSelection.mockClear();
    mockDek.mockReturnValue(null);
    await fs.mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    environmentKeys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  async function put(name: string, value: string | Buffer) {
    const file = path.join(workspace, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  }

  it('captures FLUJO entities and private MCP settings while excluding disposable runtime state', async () => {
    const records = {
      'db/models.json': '[{"id":"model-one","adapter":"openai","ApiKey":"encrypted:test"}]',
      'db/flows/flow-one.json': '{"id":"flow-one","model":"model-one","mcp":"test-server"}',
      'db/conversations/chat-one.json': '{"conversationId":"chat-one","flowId":"flow-one"}',
      'db/conversation-logs/chat-one.jsonl': '{"sequence":1,"message":"hello"}\n',
      'db/mcp_servers.json': '{"test-server":{"transport":"stdio","command":"npx","args":["-y","example@1.0"],"env":{"API_KEY":"encrypted:synthetic"}}}',
      'userdata/project/script.py': 'print("worker")\n',
    };
    for (const [name, value] of Object.entries(records)) await put(name, value);
    await put('db/codex-runtime/state_5.sqlite', Buffer.from('SQLite format 3\0synthetic'));
    await put('db/codex-runtime/state_5.sqlite-wal', 'synthetic wal');
    await put('db/codex-runtime/auth.json', 'stale auth');
    await put('mcp-servers/old-path/node_modules/dependency/index.js', 'old runtime');
    await put('userdata/mcp-runtime/provider-state.sqlite', Buffer.from('SQLite format 3\0synthetic'));
    await put('browser-profile/browser-state', 'local profile');
    const captured = await captureWorkspaceSnapshot('research', 3);
    for (const [name, value] of Object.entries(records)) expect(await captured.zip.file(name)!.async('string')).toBe(value);
    expect(captured.manifest.files.map(file => file.path)).toEqual(Object.keys(records).sort((a, b) => a.localeCompare(b)));
    expect(captured.manifest.runtime.codexAuth).toBe('none');
    expect(mockBuildPlan).toHaveBeenCalledWith([expect.objectContaining({ name: 'test-server', env: { API_KEY: 'encrypted:synthetic' } })], workspace);
    expect(captured.zip.file('db/codex-runtime/state_5.sqlite')).toBeNull();
    const archive = await writeWorkspaceSnapshotArchive(captured);
    try {
      const bytes = await fs.readFile(archive.archivePath);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(archive.sha256);
      const unpacked = await JSZip.loadAsync(bytes);
      expect(JSON.parse(await unpacked.file('snapshot-manifest.json')!.async('string'))).toEqual(captured.manifest);
    } finally {
      await fs.rm(archive.stagingDir, { recursive: true, force: true });
    }
  });

  it('seeds subscription auth from the active host without copying Codex runtime databases', async () => {
    await put('db/models.json', '[{"id":"codex","adapter":"codex-cli","ApiKey":""}]');
    const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'test-access', refresh_token: 'test-refresh' } });
    await fs.mkdir(process.env.CODEX_HOME!, { recursive: true });
    await fs.writeFile(path.join(process.env.CODEX_HOME!, 'auth.json'), auth);
    await put('db/codex-runtime/auth.json', 'stale');
    const captured = await captureWorkspaceSnapshot('research', 1);
    expect(captured.manifest.runtime.codexAuth).toBe('chatgpt');
    expect(await captured.zip.file('db/codex-runtime/auth.json')!.async('string')).toBe(auth);
    expect(JSON.parse(await captured.zip.file(`db/codex-runtime/${CODEX_AUTH_SOURCE_FILE}`)!.async('string'))).toEqual({ version: 1, source: 'workspace' });
    expect(captured.manifest.files.find(file => file.path.endsWith('/auth.json'))?.mode).toBe(0o600);
  });

  it('fails before producing a clone when subscription credentials are unavailable', async () => {
    await put('db/models.json', '[{"provider":"codex"}]');
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
  });

  it('does not require a ChatGPT login for API-key Codex models', async () => {
    await put('db/models.json', '[{"adapter":"codex-cli","ApiKey":"encrypted:synthetic"}]');
    expect((await captureWorkspaceSnapshot('research', 1)).manifest.runtime.codexAuth).toBe('none');
  });

  it('exports the already-unlocked workspace DEK and rejects a locked USER workspace', async () => {
    await put('db/encryption_key.json', '{"encryption_type":"user"}');
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    mockDek.mockReturnValue('a'.repeat(16));
    const captured = await captureWorkspaceSnapshot('research', 1);
    expect(captured.manifest.runtime.encryption).toBe('user');
    expect(JSON.parse(await captured.zip.file('db/worker-bootstrap-secrets.json')!.async('string'))).toEqual({ version: 1, workspaceDek: 'a'.repeat(16) });
  });

  it('refuses an opaque SQLite database in user data instead of making a torn live backup', async () => {
    await put('userdata/tool/database.sqlite', Buffer.from('SQLite format 3\0synthetic'));
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'UNSAFE_ENTRY' });
  });

  it('honors cancellation and configured size bounds', async () => {
    await put('userdata/large.txt', 'longer than the configured limit');
    process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES = '4';
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    const controller = new AbortController();
    controller.abort(new Error('test cancellation'));
    await expect(captureWorkspaceSnapshot('research', 1, { signal: controller.signal })).rejects.toThrow('test cancellation');
  });

  it('writes flow-scoped MCP changes only into the archive and updates its integrity manifest', async () => {
    const original = '{"desktop":{"transport":"stdio","command":"desktop.exe","env":{},"disabled":false}}';
    await put('db/mcp_servers.json', original);
    await put('db/flows/selected.json', '{"id":"selected","name":"Test","nodes":[],"edges":[]}');
    mockSelection.mockReturnValueOnce({
      configs: [{ name: 'desktop', transport: 'stdio', command: 'desktop.exe', env: {}, disabled: true, rootPath: '.', _buildCommand: '', _installCommand: '' }],
      flowIds: ['selected'], mcpServerNames: [], requiresCodexAuth: false,
    });
    const captured = await captureWorkspaceSnapshot('research', 1, { flowIds: ['selected'] });
    expect(mockSelection).toHaveBeenCalledWith(['selected'], expect.objectContaining({
      flows: [expect.objectContaining({ id: 'selected' })],
    }));
    expect(await fs.readFile(path.join(workspace, 'db/mcp_servers.json'), 'utf8')).toBe(original);
    const content = await captured.zip.file('db/mcp_servers.json')!.async('nodebuffer');
    expect(JSON.parse(content.toString()).desktop.disabled).toBe(true);
    const manifestFiles = captured.manifest.files.filter(file => file.path === 'db/mcp_servers.json');
    expect(manifestFiles).toHaveLength(1);
    expect(manifestFiles[0].sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(captured.manifest.runtime.selectedFlowIds).toEqual(['selected']);
    expect(captured.bytes).toBe(captured.manifest.files.reduce((total, file) => total + file.size, 0));
  });
});
