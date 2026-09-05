import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import { version } from '../../package.json';
import { restoreConfiguredWorkerSnapshot, unlockWorkerSnapshot } from '@/backend/services/workspace/snapshotRestore';
import { WORKSPACE_LAYOUT_VERSION } from '@/backend/services/workspace/layoutVersion';
import { getWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';
import { WORKSPACE_SUBTREES, runWithWorkspace } from '@/utils/workspace';
import { getServerDek } from '@/utils/encryption/session';

const digest = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const environmentKeys = ['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_WORKER_MODE',
  'FLUJO_WORKER_SNAPSHOT', 'FLUJO_WORKER_SNAPSHOT_SHA256', 'FLUJO_WORKER_SNAPSHOT_KEY', 'FLUJO_SNAPSHOT_MAX_FILE_BYTES'] as const;

describe('worker snapshot restore', () => {
  let root: string;
  let previous: Array<string | undefined>;
  let destination: string;

  beforeEach(async () => {
    previous = environmentKeys.map(key => process.env[key]);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-worker-restore-'));
    destination = path.join(root, 'target', 'workspaces', 'research');
    process.env.FLUJO_DATA_DIR = path.join(root, 'target');
    delete process.env.FLUJO_PARENT_DATA_DIR;
    process.env.FLUJO_WORKER_MODE = '1';
    delete process.env.FLUJO_WORKER_SNAPSHOT_KEY;
    delete process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES;
    global.__flujo_worker_snapshot_restore = undefined;
    global.__flujo_worker_bootstrap_status = undefined;
  });

  afterEach(async () => {
    environmentKeys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    global.__flujo_worker_snapshot_restore = undefined;
    global.__flujo_worker_bootstrap_status = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });

  async function archive(options: {
    files?: Record<string, string>;
    mutateManifest?: (manifest: any) => void;
    extraFile?: [string, string];
    mutateBytes?: (bytes: Buffer) => Buffer;
  } = {}) {
    const files = options.files ?? {
      'db/flows/flow-one.json': '{"id":"flow-one"}',
      'db/models.json': '[{"id":"model-one"}]',
      'db/conversations/chat-one.json': '{"conversationId":"chat-one","messages":[]}',
      'db/conversation-logs/chat-one.jsonl': '{"sequence":1}\n',
      '.workspace.json': '{"roots":["C:\\private"]}',
      'userdata/run.sh': '#!/bin/sh\necho ready\n',
    };
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) {
      zip.file(name, content, { unixPermissions: name.endsWith('.sh') ? 0o100755 : 0o100644 });
    }
    const manifest = {
      formatVersion: 2, layoutVersion: WORKSPACE_LAYOUT_VERSION, workspace: 'research',
      generation: 1, createdAt: new Date().toISOString(), coherence: 'registered-flujo-writers',
      externalRootsIncluded: false, source: { version, platform: 'win32' }, subtrees: [...WORKSPACE_SUBTREES],
      files: Object.entries(files).map(([name, content]) => ({ path: name, size: Buffer.byteLength(content), sha256: digest(content) })),
      runtime: { codexAuth: 'none', encryption: 'default', mcpTransfer: { formatVersion: 1, sourceWorkspaceRoot: 'C:\\source\\research', servers: [] } },
    };
    options.mutateManifest?.(manifest);
    zip.file('snapshot-manifest.json', JSON.stringify(manifest));
    if (options.extraFile) zip.file(...options.extraFile);
    let bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
    if (options.mutateBytes) bytes = options.mutateBytes(bytes);
    process.env.FLUJO_WORKER_SNAPSHOT = path.join(root, 'worker.zip');
    process.env.FLUJO_WORKER_SNAPSHOT_SHA256 = digest(bytes);
    await fs.writeFile(process.env.FLUJO_WORKER_SNAPSHOT, bytes);
    return bytes;
  }

  it('preserves entity IDs and conversation logs while clearing host roots', async () => {
    await archive();
    const restored = await restoreConfiguredWorkerSnapshot();
    expect(restored?.workspace).toBe('research');
    expect(await fs.readFile(path.join(destination, 'db/flows/flow-one.json'), 'utf8')).toBe('{"id":"flow-one"}');
    expect(await fs.readFile(path.join(destination, 'db/conversation-logs/chat-one.jsonl'), 'utf8')).toBe('{"sequence":1}\n');
    expect(JSON.parse(await fs.readFile(path.join(destination, '.workspace.json'), 'utf8'))).toEqual({ roots: [] });
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(destination, 'userdata/run.sh'))).mode & 0o777).toBe(0o700);
    }
    expect(getWorkerBootstrapStatus().state).not.toBe('ready');
  });

  it('reuses matching restart state without overwriting worker results', async () => {
    await archive();
    await restoreConfiguredWorkerSnapshot();
    await fs.writeFile(path.join(destination, 'db/flows/flow-one.json'), '{"id":"flow-one","workerChange":true}');
    global.__flujo_worker_snapshot_restore = undefined;
    await restoreConfiguredWorkerSnapshot();
    expect(await fs.readFile(path.join(destination, 'db/flows/flow-one.json'), 'utf8')).toContain('workerChange');
  });

  it('refuses to overwrite existing data', async () => {
    await archive();
    await fs.mkdir(path.join(destination, 'db'), { recursive: true });
    await fs.writeFile(path.join(destination, 'db/existing.json'), 'existing');
    await expect(restoreConfiguredWorkerSnapshot()).rejects.toThrow('overwrite');
    expect(await fs.readFile(path.join(destination, 'db/existing.json'), 'utf8')).toBe('existing');
  });

  it('accepts the official image empty workspace skeleton', async () => {
    await archive();
    for (const subtree of WORKSPACE_SUBTREES) await fs.mkdir(path.join(destination, subtree), { recursive: true });
    await expect(restoreConfiguredWorkerSnapshot()).resolves.toMatchObject({ workspace: 'research' });
  });

  it.each([
    ['unknown files', { extraFile: ['db/undeclared.json', '{}'] as [string, string] }],
    ['path traversal', { extraFile: ['../outside.json', '{}'] as [string, string] }],
    ['case aliases', { extraFile: ['DB/models.json', '{}'] as [string, string] }],
    ['bad member hash', { mutateManifest: (manifest: any) => { manifest.files[0].sha256 = '0'.repeat(64); } }],
    ['incompatible version', { mutateManifest: (manifest: any) => { manifest.source.version = '0.0.0'; } }],
    ['missing Codex login', { mutateManifest: (manifest: any) => { manifest.runtime.codexAuth = 'chatgpt'; } }],
  ])('rejects %s before publishing a workspace', async (_name, options) => {
    await archive(options);
    await expect(restoreConfiguredWorkerSnapshot()).rejects.toThrow();
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(getWorkerBootstrapStatus().state).toBe('error');
  });

  it('rejects duplicate original ZIP paths before JSZip collapses them', async () => {
    await archive({ files: { 'db/a.json': '{}', 'db/b.json': '{}' }, mutateBytes: bytes => {
      // Equal-length rename creates duplicate local and central directory names.
      return Buffer.from(bytes.toString('latin1').replaceAll('db/b.json', 'db/a.json'), 'latin1');
    } });
    await expect(restoreConfiguredWorkerSnapshot()).rejects.toThrow('duplicate');
  });

  it('checks outer SHA and decompressed-size limits before extraction', async () => {
    await archive();
    process.env.FLUJO_WORKER_SNAPSHOT_SHA256 = '0'.repeat(64);
    await expect(restoreConfiguredWorkerSnapshot()).rejects.toThrow('SHA-256');
    await archive();
    process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES = '4';
    await expect(restoreConfiguredWorkerSnapshot()).rejects.toThrow('size limit');
  });

  it('authenticates the encrypted envelope before checking the plaintext ZIP digest', async () => {
    const plaintext = await archive();
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = { format: 'flujo-workspace-encrypted', version: 1,
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = key.toString('base64');
    await fs.writeFile(process.env.FLUJO_WORKER_SNAPSHOT!, JSON.stringify(envelope));
    await expect(restoreConfiguredWorkerSnapshot()).resolves.toMatchObject({ archiveSha256: digest(plaintext) });
    global.__flujo_worker_snapshot_restore = undefined;
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = randomBytes(32).toString('base64');
    await expect(restoreConfiguredWorkerSnapshot()).rejects.toThrow('decryption failed');
  });

  it('unlocks USER encryption in the selected workspace using only the scoped bootstrap key', async () => {
    await archive({ files: { 'db/worker-bootstrap-secrets.json': '{"version":1,"workspaceDek":"0123456789abcdef"}' },
      mutateManifest: manifest => { manifest.runtime.encryption = 'user'; } });
    const result = (await restoreConfiguredWorkerSnapshot())!;
    await runWithWorkspace('research', async () => {
      await unlockWorkerSnapshot(result);
      expect(getServerDek()).toBe('0123456789abcdef');
    });
    expect(JSON.stringify(getWorkerBootstrapStatus())).not.toContain('0123456789abcdef');
  });

  it('does not surface malformed credential contents in restore status', async () => {
    const secret = 'synthetic-secret-that-must-not-appear';
    await archive({ files: {
      'db/codex-runtime/auth.json': secret,
      'db/codex-runtime/flujo-auth-source.json': '{"version":1,"source":"workspace"}',
    }, mutateManifest: manifest => { manifest.runtime.codexAuth = 'chatgpt'; } });
    await expect(restoreConfiguredWorkerSnapshot()).rejects.toThrow('authentication is missing or invalid');
    expect(JSON.stringify(getWorkerBootstrapStatus())).not.toContain(secret);
    await archive({ files: { 'db/worker-bootstrap-secrets.json': secret },
      mutateManifest: manifest => { manifest.runtime.encryption = 'user'; } });
    await expect(restoreConfiguredWorkerSnapshot()).rejects.toThrow('credentials are invalid');
    expect(JSON.stringify(getWorkerBootstrapStatus())).not.toContain(secret);
  });

  it('leaves local startup independent of worker environment fields', async () => {
    delete process.env.FLUJO_WORKER_MODE;
    process.env.FLUJO_WORKER_SNAPSHOT = 'invalid';
    await expect(restoreConfiguredWorkerSnapshot()).resolves.toBeNull();
  });
});
