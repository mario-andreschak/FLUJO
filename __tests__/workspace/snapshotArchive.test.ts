import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
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

import { captureWorkspaceSnapshot as captureProductionSnapshot, writeWorkspaceSnapshotArchive } from '@/backend/services/workspace/snapshotArchive';
import { runWithWorkspace } from '@/utils/workspace';
import { encryptWithPassword, getOperatorWorkerBootstrapKey } from '@/utils/encryption/secure';
import { parseSessionKey, open, type EncryptionMetadata } from '@/utils/encryption/format';
import { archiveModelDispatch } from '@/backend/execution/flow/modelTurnArchive';

const captures: Awaited<ReturnType<typeof captureProductionSnapshot>>[] = [];
async function captureWorkspaceSnapshot(...args: Parameters<typeof captureProductionSnapshot>) {
  const captured = await captureProductionSnapshot(...args);
  captures.push(captured);
  return captured;
}

const environmentKeys = ['FLUJO_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE', 'FLUJO_PARENT_DATA_DIR', 'CODEX_HOME', 'FLUJO_WORKER_SNAPSHOT_KEY', 'FLUJO_SNAPSHOT_MAX_BYTES', 'FLUJO_SNAPSHOT_MAX_FILE_BYTES'] as const;

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
    delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
    delete process.env.FLUJO_PARENT_DATA_DIR;
    delete process.env.FLUJO_WORKER_SNAPSHOT_KEY;
    delete process.env.FLUJO_SNAPSHOT_MAX_BYTES;
    delete process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES;
    mockBuildPlan.mockClear();
    mockSelection.mockClear();
    mockDek.mockReturnValue(null);
    await fs.mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    for (const captured of captures.splice(0)) await captured.dispose?.();
    jest.restoreAllMocks();
    environmentKeys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('pins an explicit recipient key without changing or depending on the ambient key', async () => {
    await put('userdata/member.txt', 'recipient transfer');
    const recipient = randomBytes(32);
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = 'invalid ambient key';
    const captured = await captureWorkspaceSnapshot('research', 1, { recipientKey: recipient.toString('base64') });
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = randomBytes(32).toString('base64');
    const ambient = process.env.FLUJO_WORKER_SNAPSHOT_KEY;
    const result = await writeWorkspaceSnapshotArchive(captured);
    try {
      expect(result.recipientKeyUsed).toBe(true);
      expect(process.env.FLUJO_WORKER_SNAPSHOT_KEY).toBe(ambient);
      const envelope = JSON.parse((await fs.readFile(result.archivePath)).toString());
      const decipher = createDecipheriv('aes-256-gcm', recipient, Buffer.from(envelope.iv, 'base64'));
      if (envelope.version === 2) decipher.setAAD(Buffer.from('flujo:workspace-snapshot:v2'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      expect(createHash('sha256').update(plaintext).digest('hex')).toBe(result.plaintextSha256);
      const restored = await JSZip.loadAsync(plaintext);
      expect(await restored.file('userdata/member.txt')!.async('string')).toBe('recipient transfer');
    } finally { await fs.rm(result.stagingDir, { recursive: true, force: true }); }
  });

  it('preserves repeated ZIP generation and member inspection from immutable spool bytes', async () => {
    await put('userdata/member.txt', 'captured generation');
    const captured = await captureWorkspaceSnapshot('research', 1);
    await put('userdata/member.txt', 'later generation');
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await captured.zip.file('userdata/member.txt')!.async('string')).toBe('captured generation');
      expect(await captured.zip.file('userdata/member.txt')!.async('base64')).toBe(Buffer.from('captured generation').toString('base64'));
      const generated = await JSZip.loadAsync(await captured.zip.generateAsync({ type: 'nodebuffer' }));
      expect(await generated.file('userdata/member.txt')!.async('string')).toBe('captured generation');
    }
  });

  it('rejects SQLite state disguised as workspace metadata', async () => {
    await put('.workspace.json', Buffer.from('SQLite format 3\0extra'));
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'UNSAFE_ENTRY' });
  });

  async function put(name: string, value: string | Buffer) {
    const file = path.join(workspace, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  }

  function decryptArchive(wire: Buffer): Buffer {
    const envelope = JSON.parse(wire.toString());
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(process.env.FLUJO_WORKER_SNAPSHOT_KEY!, 'base64'), Buffer.from(envelope.iv, 'base64'));
    if (envelope.version === 2) decipher.setAAD(Buffer.from('flujo:workspace-snapshot:v2'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  }

  it.each([
    ['models', '[{"ApiKey":"public-profile-api-secret"}]'],
    ['mcp_servers', '{"server":{"env":{"PRIVATE_TOKEN":"plain-secret"}}}'],
    ['global_env_vars', '{"PRIVATE_TOKEN":"global-secret"}'],
    ['registry_account', '{"token":"registry-secret"}'],
  ])('requires encryption for credential material in %s even in a default profile', async (store, contents) => {
    await put(`db/${store}.json`, contents);
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = randomBytes(32).toString('base64');
    const captured = await captureWorkspaceSnapshot('research', 1);
    const archive = await writeWorkspaceSnapshotArchive(captured);
    try {
      const wire = await fs.readFile(archive.archivePath);
      expect(archive.encrypted).toBe(true);
      const zip = await JSZip.loadAsync(decryptArchive(wire));
      expect(await zip.file(`db/${store}.json`)!.async('string')).toBe(contents);
    } finally { await fs.rm(archive.stagingDir, { recursive: true, force: true }); }
  });

  it('captures FLUJO entities and private MCP settings while excluding disposable runtime state', async () => {
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = randomBytes(32).toString('base64');
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
    const nativePrivatePaths = [
      'db/native-tool-journal/calls/original.json',
      'db/native-session-payloads/original/payload.json',
      'db/native-session-origins/original.json',
      'db/native-session-origins/host-ledger/goal-original.json',
    ];
    for (const name of nativePrivatePaths) await put(name, 'private native request or journal');
    const ordinary = await runWithWorkspace('research', () => archiveModelDispatch({
      conversationId: 'chat-one', runId: 'ordinary-core-run', nodeId: 'ordinary-process',
      modelId: 'model-one', modelName: 'ordinary fixture', adapter: 'openai', operation: 'create', attempt: 1,
      canonicalMessages: [{ id: 'ordinary-user', role: 'user', content: 'Preserve ordinary Core history', timestamp: 1 }],
      genericWire: [{ role: 'user', content: 'Preserve ordinary Core history' }], sdkRequest: { ordinary: true },
    }));
    const ordinaryPath = `db/model-turns/chat-one/${ordinary.id}.v2.json.gz`;
    const ordinaryBytes = await fs.readFile(path.join(workspace, ordinaryPath));
    await put('mcp-servers/old-path/node_modules/dependency/index.js', 'old runtime');
    await put('userdata/mcp-runtime/provider-state.sqlite', Buffer.from('SQLite format 3\0synthetic'));
    await put('browser-profile/browser-state', 'local profile');
    const captured = await captureWorkspaceSnapshot('research', 3);
    for (const [name, value] of Object.entries(records)) expect(await captured.zip.file(name)!.async('string')).toBe(value);
    expect(captured.manifest.files.map(file => file.path)).toEqual([...Object.keys(records), ordinaryPath].sort((a, b) => a.localeCompare(b)));
    expect(await captured.zip.file(ordinaryPath)!.async('nodebuffer')).toEqual(ordinaryBytes);
    expect(captured.manifest.runtime.codexAuth).toBe('none');
    expect(mockBuildPlan).toHaveBeenCalledWith([expect.objectContaining({ name: 'test-server', env: { API_KEY: 'encrypted:synthetic' } })], workspace);
    expect(captured.zip.file('db/codex-runtime/state_5.sqlite')).toBeNull();
    for (const name of nativePrivatePaths) {
      expect(captured.zip.file(name)).toBeNull();
      expect(captured.manifest.files.some(file => file.path === name)).toBe(false);
    }
    const archive = await writeWorkspaceSnapshotArchive(captured);
    try {
      const bytes = await fs.readFile(archive.archivePath);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(archive.sha256);
      const unpacked = await JSZip.loadAsync(decryptArchive(bytes));
      expect(JSON.parse(await unpacked.file('snapshot-manifest.json')!.async('string'))).toEqual(captured.manifest);
      expect(archive.encrypted).toBe(true);
      expect(await unpacked.file(ordinaryPath)!.async('nodebuffer')).toEqual(ordinaryBytes);
      for (const name of nativePrivatePaths) expect(unpacked.file(name)).toBeNull();
    } finally {
      await fs.rm(archive.stagingDir, { recursive: true, force: true });
    }
  });

  it.each([undefined, 'invalid'])('refuses selected subscription auth without a valid encryption key %s', async (key) => {
    if (key) process.env.FLUJO_WORKER_SNAPSHOT_KEY = key;
    await put('db/models.json', '[{"id":"codex","adapter":"codex-cli","ApiKey":""}]');
    const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'test-access', refresh_token: 'test-refresh' } });
    await fs.mkdir(process.env.CODEX_HOME!, { recursive: true });
    await fs.writeFile(path.join(process.env.CODEX_HOME!, 'auth.json'), auth);
    await put('db/codex-runtime/auth.json', 'stale');
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    expect(await fs.readFile(path.join(process.env.CODEX_HOME!, 'auth.json'), 'utf8')).toBe(auth);
  });

  it('writes selected auth only inside an authenticated envelope and separates wire and restore digests', async () => {
    const key = randomBytes(32);
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = key.toString('base64');
    await put('db/models.json', '[{"id":"codex","adapter":"codex-cli","ApiKey":""}]');
    const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'encrypted-export-canary', refresh_token: 'refresh-canary' } });
    await fs.mkdir(process.env.CODEX_HOME!, { recursive: true });
    await fs.writeFile(path.join(process.env.CODEX_HOME!, 'auth.json'), auth);
    const captured = await captureWorkspaceSnapshot('research', 1);
    const archive = await writeWorkspaceSnapshotArchive(captured);
    try {
      const wire = await fs.readFile(archive.archivePath);
      expect(wire.toString()).not.toContain('encrypted-export-canary');
      expect(archive.encrypted).toBe(true);
      expect(archive.sha256).toBe(createHash('sha256').update(wire).digest('hex'));
      const envelope = JSON.parse(wire.toString());
      expect(envelope).toMatchObject({ format: 'flujo-workspace-encrypted', version: 2 });
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      if (envelope.version === 2) decipher.setAAD(Buffer.from('flujo:workspace-snapshot:v2'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      expect(archive.plaintextSha256).toBe(createHash('sha256').update(plaintext).digest('hex'));
      expect(archive.sha256).not.toBe(archive.plaintextSha256);
      const refreshed = await writeWorkspaceSnapshotArchive(captured);
      try {
        const refreshedEnvelope = JSON.parse((await fs.readFile(refreshed.archivePath)).toString());
        expect(refreshedEnvelope.iv).not.toBe(envelope.iv);
        expect(refreshed.sha256).not.toBe(archive.sha256);
        expect(refreshed.plaintextSha256).toBe(archive.plaintextSha256);
      } finally { await fs.rm(refreshed.stagingDir, { recursive: true, force: true }); }

      const restored = await JSZip.loadAsync(plaintext);
      expect(await restored.file('db/codex-runtime/auth.json')!.async('string')).toBe(auth);
      expect(await fs.readdir(archive.stagingDir)).toEqual(['workspace.snapshot.zip']);
    } finally { await fs.rm(archive.stagingDir, { recursive: true, force: true }); }
  });

  it.each(['remove', 'replace', 'invalid'])('refuses key %s between capture and write', async (change) => {
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = randomBytes(32).toString('base64');
    const captured = await captureWorkspaceSnapshot('research', 1);
    if (change === 'remove') delete process.env.FLUJO_WORKER_SNAPSHOT_KEY;
    else process.env.FLUJO_WORKER_SNAPSHOT_KEY = change === 'invalid' ? 'invalid' : randomBytes(32).toString('base64');
    const staging = jest.spyOn(fs, 'mkdtemp');
    await expect(writeWorkspaceSnapshotArchive(captured)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    expect(staging).not.toHaveBeenCalled();
  });

  it('omits live and stale restricted homes without a selected Codex model', async () => {
    await put('db/models.json', '[]');
    for (const home of ['codex-private-live', 'codex-private-stale', 'CODEX-PRIVATE-alias']) {
      await put(`db/${home}/auth.json`, JSON.stringify({ tokens: { access_token: `canary-${home}` } }));
      await put(`db/${home}/sessions/session.jsonl`, 'private transcript');
    }
    await put('db/codex-private-notes.json', 'also excluded by reserved prefix');
    await put('userdata/kept.txt', 'ordinary data');
    const captured = await captureWorkspaceSnapshot('research', 1);
    expect(captured.manifest.runtime.codexAuth).toBe('none');
    expect(Object.keys(captured.zip.files).some(name => /codex-private-/i.test(name))).toBe(false);
    const archive = await writeWorkspaceSnapshotArchive(captured);
    try {
      const bytes = await fs.readFile(archive.archivePath);
      const unpacked = await JSZip.loadAsync(bytes);
      expect(await unpacked.file('userdata/kept.txt')!.async('string')).toBe('ordinary data');
      expect(Object.keys(unpacked.files).some(name => /codex-private-/i.test(name))).toBe(false);
    } finally { await fs.rm(archive.stagingDir, { recursive: true, force: true }); }
  });

  it('refuses credential-bearing captures at the plaintext writer boundary', async () => {
    const captured = await captureWorkspaceSnapshot('research', 1);
    captured.manifest.runtime.codexAuth = 'chatgpt';
    await expect(writeWorkspaceSnapshotArchive(captured)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    captured.manifest.runtime.codexAuth = 'none';
    captured.zip.file('db/codex-private-stale/auth.json', 'synthetic secret');
    await expect(writeWorkspaceSnapshotArchive(captured)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
  });

  it('fails before producing a clone when subscription credentials are unavailable', async () => {
    await put('db/models.json', '[{"provider":"codex"}]');
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
  });

  it('does not require a ChatGPT login for API-key Codex models', async () => {
    await put('db/models.json', '[{"adapter":"codex-cli","ApiKey":"encrypted:synthetic"}]');
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = randomBytes(32).toString('base64');
    expect((await captureWorkspaceSnapshot('research', 1)).manifest.runtime.codexAuth).toBe('none');
  });

  it('exports the already-unlocked workspace DEK and rejects a locked USER workspace', async () => {
    await put('db/encryption_key.json', '{"encryption_type":"user"}');
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    mockDek.mockReturnValue('a'.repeat(16));
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = randomBytes(32).toString('base64');
    const captured = await captureWorkspaceSnapshot('research', 1);
    expect(captured.manifest.runtime.encryption).toBe('user');
    expect(JSON.parse(await captured.zip.file('db/worker-bootstrap-secrets.json')!.async('string'))).toEqual({ version: 1, workspaceDek: 'a'.repeat(16) });
    const archive = await writeWorkspaceSnapshotArchive(captured);
    try {
      const wire = await fs.readFile(archive.archivePath);
      expect(archive.encrypted).toBe(true);
      expect(wire.toString()).not.toContain('a'.repeat(16));
      expect(() => JSON.parse(wire.toString())).not.toThrow();
      await expect(JSZip.loadAsync(wire)).rejects.toThrow();
    } finally { await fs.rm(archive.stagingDir, { recursive: true, force: true }); }

  });

  it('captures a headless operator profile without an interactive key and refuses missing or changed mounts', async () => {
    const secretRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-independent-operator-'));
    const secretFile = path.join(secretRoot, 'secret');
    const secret = randomBytes(32).toString('base64url');
    try {
      await fs.writeFile(secretFile, secret, { mode: 0o600 });
      process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
      const ciphertext = await runWithWorkspace('research', () => encryptWithPassword('operator-worker-token'));
      await put('db/models.json', JSON.stringify([{ id: 'headless', ApiKey: `encrypted:${ciphertext}` }]));
      expect(mockDek()).toBeNull();
      await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
      process.env.FLUJO_WORKER_SNAPSHOT_KEY = randomBytes(32).toString('base64');
      const captured = await captureWorkspaceSnapshot('research', 1);
      const bootstrap = JSON.parse(await captured.zip.file('db/worker-bootstrap-secrets.json')!.async('string'));
      const ring = parseSessionKey(bootstrap.workspaceDek);
      expect('activeKey' in ring).toBe(true);
      if (!('activeKey' in ring)) throw new Error('Expected private keyring');
      expect(open(ciphertext!, ring.activeKey, 'flujo:secret:v2')).toBe('operator-worker-token');
      expect(JSON.stringify(captured.manifest)).not.toContain('operator-worker-token');
      expect(await captured.zip.file('db/encryption_key.json')!.async('string')).not.toContain(secret);
      expect(captured.manifest.files.find(file => file.path === 'db/worker-bootstrap-secrets.json')?.mode).toBe(0o600);
      const metadata = JSON.parse(await captured.zip.file('db/encryption_key.json')!.async('string')) as EncryptionMetadata;
      await expect(runWithWorkspace('research', () => getOperatorWorkerBootstrapKey({ ...metadata, key_id: 'changed' })))
        .rejects.toThrow('metadata changed');
      await fs.writeFile(secretFile, randomBytes(32).toString('base64url'));
      await expect(captureWorkspaceSnapshot('research', 2)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
      await fs.unlink(secretFile);
      await expect(captureWorkspaceSnapshot('research', 3)).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
      await fs.writeFile(secretFile, secret, { mode: 0o600 });
      expect((await captureWorkspaceSnapshot('research', 4)).manifest.runtime.encryption).toBe('user');
    } finally { await fs.rm(secretRoot, { recursive: true, force: true }); }
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

  it('counts directories against the receiver member bound before staging or compression', async () => {
    const captured = await captureWorkspaceSnapshot('research', 1);
    captured.zip.files = Object.fromEntries(Array.from({ length: 65_535 }, (_, index) => [`directory-${index}/`, {}])) as JSZip['files'];
    const create = jest.spyOn(fs, 'mkdtemp');
    const generate = jest.spyOn(captured.zip, 'generateNodeStream');
    try {
      await expect(writeWorkspaceSnapshotArchive(captured)).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
      expect(create).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    } finally { create.mockRestore(); generate.mockRestore(); }
  });

  it('refuses a manifest beyond the advertised receiver limit', async () => {
    mockBuildPlan.mockReturnValueOnce({ formatVersion: 1, sourceWorkspaceRoot: 'x'.repeat(8 * 1024 * 1024), servers: [] });
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
  });

  it('writes flow-scoped MCP changes only into the archive and updates its integrity manifest', async () => {
    const original = '{"desktop":{"transport":"stdio","command":"desktop.exe","env":{},"disabled":false}}';
    await put('db/mcp_servers.json', original);
    await put('db/flows/selected.json', '{"id":"selected","name":"Test","nodes":[],"edges":[]}');
    mockSelection.mockReturnValueOnce({
      configs: [{ name: 'desktop', transport: 'stdio', command: 'desktop.exe', env: {}, disabled: true, rootPath: '.', _buildCommand: '', _installCommand: '' }],
      flowIds: ['selected'], mcpServerNames: [], requiresCodexAuth: false,
    });
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = randomBytes(32).toString('base64');
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

  it('refuses workspace metadata swapped after containment checks', async () => {
    await put('.workspace.json', '{"roots":[]}');
    const metadata = path.join(workspace, '.workspace.json');
    const open = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === metadata) {
        await fs.rename(metadata, `${metadata}.original`);
        await fs.writeFile(metadata, '{"roots":["external"]}');
      }
      return open(...args);
    });
    await expect(captureWorkspaceSnapshot('research', 1)).rejects.toMatchObject({ code: 'UNSAFE_ENTRY' });
  });
});
