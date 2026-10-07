import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import { version } from '../../package.json';
import { writeWorkspaceSnapshotArchive } from '@/backend/services/workspace/snapshotArchive';
import { restoreConfiguredWorkerSnapshot, unlockWorkerSnapshot } from '@/backend/services/workspace/snapshotRestore';
import { WORKSPACE_LAYOUT_VERSION } from '@/backend/services/workspace/layoutVersion';
import { getWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';
import { WORKSPACE_SUBTREES, runWithWorkspace } from '@/utils/workspace';
import { getServerDek } from '@/utils/encryption/session';
import { metadataRevision, newKeyring, seal, serializeKeyring, wrapKeyring } from '@/utils/encryption/format';
import { decryptWithPassword, isEncryptionLocked } from '@/utils/encryption/secure';

const digest = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const environmentKeys = ['FLUJO_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_WORKER_MODE',
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
    delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
    delete process.env.FLUJO_PARENT_DATA_DIR;
    process.env.FLUJO_WORKER_MODE = '1';
    delete process.env.FLUJO_WORKER_SNAPSHOT_KEY;
    delete process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES;
    global.__flujo_worker_snapshot_restore = undefined;
    global.__flujo_worker_bootstrap_status = undefined;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
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

  it.each(['valid', 'wrong-key', 'tamper', 'wrong-digest'])('restores the production encrypted writer with %s integrity', async (scenario) => {
    const plaintext = await archive();
    const zip = await JSZip.loadAsync(plaintext);
    const manifest = JSON.parse(await zip.file('snapshot-manifest.json')!.async('string'));
    const key = randomBytes(32).toString('base64');
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = key;
    const exported = await writeWorkspaceSnapshotArchive({ zip, manifest, files: manifest.files.length, bytes: plaintext.length });
    try {
      const wire = await fs.readFile(exported.archivePath);
      expect(exported.encrypted).toBe(true);
      expect(digest(wire)).toBe(exported.sha256);
      expect(exported.plaintextSha256).not.toBe(exported.sha256);
      process.env.FLUJO_WORKER_SNAPSHOT = exported.archivePath;
      process.env.FLUJO_WORKER_SNAPSHOT_SHA256 = exported.plaintextSha256;
      if (scenario === 'wrong-key') process.env.FLUJO_WORKER_SNAPSHOT_KEY = randomBytes(32).toString('base64');
      if (scenario === 'wrong-digest') process.env.FLUJO_WORKER_SNAPSHOT_SHA256 = exported.sha256;
      if (scenario === 'tamper') {
        const envelope = JSON.parse(wire.toString());
        const data = Buffer.from(envelope.data, 'base64'); data[0] ^= 1;
        envelope.data = data.toString('base64');
        await fs.writeFile(exported.archivePath, JSON.stringify(envelope));
      }
      if (scenario === 'valid') {
        await expect(restoreConfiguredWorkerSnapshot()).resolves.toMatchObject({ archiveSha256: exported.plaintextSha256 });
        global.__flujo_worker_snapshot_restore = undefined;
        await expect(restoreConfiguredWorkerSnapshot()).resolves.toMatchObject({ archiveSha256: exported.plaintextSha256 });
        expect(await fs.readFile(path.join(destination, 'db/flows/flow-one.json'), 'utf8')).toBe('{"id":"flow-one"}');
      } else {
        await expect(restoreConfiguredWorkerSnapshot()).rejects.toThrow(scenario === 'wrong-digest' ? 'SHA-256' : 'decryption failed');
        await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally { await fs.rm(exported.stagingDir, { recursive: true, force: true }); }
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

  it.each(['legacy', 'v2'])('unlocks USER encryption using matching %s metadata and actual credential decryption', async format => {
    let workspaceDek: string; let metadata; let ciphertext: string;
    if (format === 'legacy') {
      const generated = '0123456789abcdef';
      workspaceDek = Buffer.from(generated).toString('hex');
      const salt = randomBytes(16); const wrapIv = randomBytes(16);
      const wrapping = createCipheriv('aes-256-cbc', pbkdf2Sync('legacy-password', salt, 100_000, 32, 'sha256'), wrapIv);
      metadata = { encryption_version: 1, encryption_type: 'user' as const,
        data_encryption_key: Buffer.concat([wrapping.update(generated), wrapping.final()]).toString('base64'),
        data_encryption_salt: salt.toString('hex'), data_encryption_iv: wrapIv.toString('hex') };
      const iv = randomBytes(16); const cipher = createCipheriv('aes-128-cbc', Buffer.from(workspaceDek, 'hex'), iv);
      ciphertext = `${iv.toString('hex')}:${Buffer.concat([cipher.update('transferred-credential'), cipher.final()]).toString('base64')}`;
    } else {
      const ring = newKeyring(); metadata = await wrapKeyring(ring, 'user', 'worker-password', 'passphrase');
      workspaceDek = serializeKeyring(ring, metadataRevision(metadata));
      ciphertext = seal('transferred-credential', ring.activeKey, 'flujo:secret:v2');
    }
    await archive({ files: {
      'db/encryption_key.json': JSON.stringify(metadata),
      'db/worker-bootstrap-secrets.json': JSON.stringify({ version: 1, workspaceDek }),
      'db/models.json': JSON.stringify([{ id: 'credential', ApiKey: `encrypted:${ciphertext}` }]),
    }, mutateManifest: manifest => { manifest.runtime.encryption = 'user'; } });
    const result = (await restoreConfiguredWorkerSnapshot())!;
    await runWithWorkspace('research', async () => {
      await unlockWorkerSnapshot(result);
      expect(getServerDek()).toBe(workspaceDek);
      expect(await decryptWithPassword(ciphertext)).toBe('transferred-credential');
    });
    expect(JSON.stringify(getWorkerBootstrapStatus())).not.toContain(workspaceDek);
  });

  it('refuses worker unlock without matching encryption metadata', async () => {
    await archive({ files: { 'db/worker-bootstrap-secrets.json': JSON.stringify({ version: 1, workspaceDek: serializeKeyring(newKeyring()) }) },
      mutateManifest: manifest => { manifest.runtime.encryption = 'user'; } });
    const result = (await restoreConfiguredWorkerSnapshot())!;
    await expect(runWithWorkspace('research', () => unlockWorkerSnapshot(result))).rejects.toThrow();
  });

  it('unlocks a verified transferred operator profile on a worker with no source mount configured', async () => {
    const ring = newKeyring();
    const metadata = await wrapKeyring(ring, 'user', randomBytes(32).toString('base64url'), 'operator-file');
    const ciphertext = seal('transferred-worker-token', ring.activeKey, 'flujo:secret:v2');
    delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
    await archive({ files: {
      'db/encryption_key.json': JSON.stringify(metadata),
      'db/worker-bootstrap-secrets.json': JSON.stringify({ version: 1, workspaceDek: serializeKeyring(ring, metadataRevision(metadata)) }),
      'db/models.json': JSON.stringify([{ id: 'transferred', ApiKey: `encrypted:${ciphertext}` }]),
    }, mutateManifest: manifest => { manifest.runtime.encryption = 'user'; } });
    const result = (await restoreConfiguredWorkerSnapshot())!;
    await runWithWorkspace('research', async () => {
      await unlockWorkerSnapshot(result);
      expect(await isEncryptionLocked()).toBe(false);
      expect(await decryptWithPassword(ciphertext)).toBe('transferred-worker-token');
      // A configured missing mount must remain authoritative even after transfer unlock.
      process.env.FLUJO_ENCRYPTION_SECRET_FILE = path.join(root, 'missing-configured-mount');
      expect(await isEncryptionLocked()).toBe(true);
      expect(await decryptWithPassword(ciphertext)).toBeNull();
    });
  });

  it('restores operator credentials across restart while requiring the independent worker mount even with a bootstrap key', async () => {
    const secret = randomBytes(32).toString('base64url');
    const mount = path.join(root, 'independent-secret');
    await fs.writeFile(mount, secret, { mode: 0o600 });
    process.env.FLUJO_ENCRYPTION_SECRET_FILE = mount;
    const ring = newKeyring();
    const metadata = await wrapKeyring(ring, 'user', secret, 'operator-file');
    const ciphertext = seal('restored-operator-token', ring.activeKey, 'flujo:secret:v2');
    await archive({ files: {
      'db/encryption_key.json': JSON.stringify(metadata),
      'db/worker-bootstrap-secrets.json': JSON.stringify({ version: 1, workspaceDek: serializeKeyring(ring, metadataRevision(metadata)) }),
      'db/models.json': JSON.stringify([{ id: 'operator', ApiKey: `encrypted:${ciphertext}` }]),
    }, mutateManifest: manifest => { manifest.runtime.encryption = 'user'; } });
    const result = (await restoreConfiguredWorkerSnapshot())!;
    await runWithWorkspace('research', async () => {
      await unlockWorkerSnapshot(result);
      expect(await decryptWithPassword(ciphertext)).toBe('restored-operator-token');
      // Restart has no interactive session. An independent mount remains the authority.
      global.__flujo_server_deks_by_workspace = undefined;
      global.__flujo_server_dek = undefined;
      expect(await isEncryptionLocked()).toBe(false);
      expect(await decryptWithPassword(ciphertext)).toBe('restored-operator-token');
      await unlockWorkerSnapshot(result);
      await fs.unlink(mount);
      expect(await isEncryptionLocked()).toBe(true);
      expect(await decryptWithPassword(ciphertext)).toBeNull();
      await fs.writeFile(mount, secret, { mode: 0o600 });
      expect(await decryptWithPassword(ciphertext)).toBe('restored-operator-token');
    });
    const child = spawnSync(process.execPath, [path.join(process.cwd(), '__tests__/encryption/fixtures/private-profile-child.cjs'),
      process.cwd(), require.resolve('typescript')], {
      env: { ...process.env },
      input: JSON.stringify({ operation: 'read', workspace: 'research', ciphertexts: [ciphertext], expected: ['restored-operator-token'] }) + '\n',
      encoding: 'utf8', timeout: 20_000,
    });
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('{"recovered":true}');
    expect(JSON.stringify(getWorkerBootstrapStatus())).not.toContain('restored-operator-token');
  });

  it('restores a v2 keyring that can decrypt both new and legacy snapshot secrets without the password', async () => {
    const ring = newKeyring(Buffer.from('0123456789abcdef').toString('hex'));
    const metadata = await wrapKeyring(ring, 'user', 'snapshot-password');
    const iv = randomBytes(16);
    const legacyCipher = createCipheriv('aes-128-cbc', Buffer.from(ring.legacyKey!, 'hex'), iv);
    const legacyData = Buffer.concat([legacyCipher.update('old-secret', 'utf8'), legacyCipher.final()]);
    const secrets = {
      legacy: `${iv.toString('hex')}:${legacyData.toString('base64')}`,
      modern: seal('new-secret', ring.activeKey, 'flujo:secret:v2'),
    };
    await archive({ files: {
      'db/encryption_key.json': JSON.stringify(metadata),
      'db/worker-bootstrap-secrets.json': JSON.stringify({ version: 1, workspaceDek: serializeKeyring(ring, metadataRevision(metadata)) }),
      'db/test-secrets.json': JSON.stringify(secrets),
    }, mutateManifest: manifest => { manifest.runtime.encryption = 'user'; } });
    const result = (await restoreConfiguredWorkerSnapshot())!;
    await runWithWorkspace('research', async () => {
      await unlockWorkerSnapshot(result);
      const restored = JSON.parse(await fs.readFile(path.join(destination, 'db', 'test-secrets.json'), 'utf8'));
      expect(await decryptWithPassword(restored.legacy)).toBe('old-secret');
      expect(await decryptWithPassword(restored.modern)).toBe('new-secret');
    });
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

  it.each(['archive', 'marker', 'credential'] as const)('refuses a swapped %s without adopting replacement bytes', async kind => {
    const workspaceDek = '30313233343536373839616263646566';
    await archive(kind === 'credential' ? {
      files: { 'db/worker-bootstrap-secrets.json': JSON.stringify({ version: 1, workspaceDek }) },
      mutateManifest: manifest => { manifest.runtime.encryption = 'user'; },
    } : {});
    let result;
    if (kind !== 'archive') {
      result = await restoreConfiguredWorkerSnapshot();
      global.__flujo_worker_snapshot_restore = undefined;
    }
    const selected = kind === 'archive' ? process.env.FLUJO_WORKER_SNAPSHOT!
      : path.join(destination, kind === 'marker' ? '.flujo-worker-snapshot.json' : 'db/worker-bootstrap-secrets.json');
    const original = await fs.readFile(selected);
    const open = fs.open.bind(fs);
    let swapped = false;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === selected && !swapped) {
        swapped = true;
        await fs.rename(selected, `${selected}.original`);
        await fs.writeFile(selected, original, { mode: 0o600 });
      }
      return open(...args);
    });
    if (kind === 'credential') {
      await expect(runWithWorkspace('research', () => unlockWorkerSnapshot(result!))).rejects.toThrow('unsafe or changed');
    } else await expect(restoreConfiguredWorkerSnapshot()).rejects.toThrow('unsafe or changed');
    expect(swapped).toBe(true);
    expect(await fs.readFile(`${selected}.original`)).toEqual(original);
  });

  it('refuses a junction or symlink parent even when the credential inode is unchanged', async () => {
    const workspaceDek = '30313233343536373839616263646566';
    await archive({ files: { 'db/worker-bootstrap-secrets.json': JSON.stringify({ version: 1, workspaceDek }) },
      mutateManifest: manifest => { manifest.runtime.encryption = 'user'; } });
    const result = (await restoreConfiguredWorkerSnapshot())!;
    const db = path.join(destination, 'db');
    const original = path.join(root, 'original-db');
    await fs.rename(db, original);
    await fs.symlink(original, db, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(runWithWorkspace('research', () => unlockWorkerSnapshot(result))).rejects.toThrow('real directory');
  });
});
