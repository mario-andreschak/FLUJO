import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StorageKey } from '@/shared/types/storage';
import { readPlainFile } from '@/utils/readPlainFile';
import { getDataDir } from '@/utils/paths';
import { assertValidWorkspaceName, getWorkspaceDataDir, getWorkspaceDir, getWorkspacesDir, WORKSPACE_SUBTREES, withWorkspaceNamespaceMutation } from '@/utils/workspace';
import { decryptWithPassword } from '@/utils/encryption/secure';
import { DEFAULT_PASSWORD, newKeyring, open, seal, wrapKeyring } from '@/utils/encryption/format';
import { MAX_TRANSFER_BYTES, openRecipientTransfer, RecipientTransferError, sealRecipientTransfer } from '@/utils/encryption/recipientTransfer';
import { assertLinkFreeFileParent, atomicWriteWithoutLinks } from './backupRestoreFs';
import { withWorkspaceRecoveryCapture } from './workspaceMutationGate';

const STORES = [StorageKey.MODELS, StorageKey.MCP_SERVERS, StorageKey.GLOBAL_ENV_VARS, StorageKey.REGISTRY_ACCOUNT] as const;
const PURPOSE = 'flujo:secret:v2';
const LIFETIME_MS = 24 * 60 * 60 * 1000;
const secretFields = new Set(['apikey', 'password', 'passphrase', 'secret', 'token', 'privatekey', 'cookie', 'clientsecret', 'oauthclientsecret', 'accesstoken', 'refreshtoken', 'idtoken', 'oauthcodeverifier', 'authorization']);
type Transform = (value: string, credential: boolean) => Promise<unknown>;

function validateRecord(key: string, value: unknown) {
  const arrayStore = key === StorageKey.MODELS || key === StorageKey.MCP_SERVERS;
  if (!value || typeof value !== 'object' || (arrayStore ? !Array.isArray(value) : Array.isArray(value))) throw new RecipientTransferError();
  if (arrayStore && (value as unknown[]).some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw new RecipientTransferError();
}

/** Inventory: model keys, registry tokens, MCP/OAuth fields, all env/header values, all envelopes. */
async function transform(value: unknown, callback: Transform, credential = false, depth = 0, normalizeMaps = false): Promise<unknown> {
  if (depth > 100) throw new RecipientTransferError();
  if (typeof value === 'string') return callback(value, credential);
  if (Array.isArray(value)) return Promise.all(value.map(item => transform(item, callback, credential, depth + 1, normalizeMaps)));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.$flujoCredential === 1 && typeof record.plaintext === 'string' && Object.keys(record).length === 2) {
    return callback(record.plaintext, true);
  }
  const secretValue = credential || !!(record.metadata && typeof record.metadata === 'object'
    && (record.metadata as Record<string, unknown>).isSecret);
  const result: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(record)) {
    const normalized = name.replace(/[_-]/g, '').toLowerCase();
    const isMap = normalized === 'env' || normalized === 'headers';
    const mapped = isMap && item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(await Promise.all(Object.entries(item).map(async ([key, entry]) => {
        const mapped = await transform(entry, callback, true, depth + 1, normalizeMaps);
        return [key, normalizeMaps ? typeof mapped === 'string'
          ? { value: mapped, metadata: { isSecret: true } }
          : { ...(mapped as Record<string, unknown>), metadata: { isSecret: true } } : mapped];
      })))
      : await transform(item, callback, secretFields.has(normalized) || (name === 'value' && secretValue), depth + 1, normalizeMaps);
    Object.defineProperty(result, name, { value: mapped, enumerable: true });
  }
  return result;
}

async function sourceValue(value: string, credential: boolean): Promise<unknown> {
  if (value.startsWith('encrypted_failed:')) return { $flujoCredential: 1, plaintext: value.slice('encrypted_failed:'.length) };
  const ciphertext = value.startsWith('encrypted:') ? value.slice('encrypted:'.length)
    : value.startsWith('v2:') || /^[a-f0-9]{32}:[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined;
  if (ciphertext === undefined) return credential && value ? { $flujoCredential: 1, plaintext: value } : value;
  const plaintext = await decryptWithPassword(ciphertext);
  if (plaintext === null) throw new RecipientTransferError();
  return { $flujoCredential: 1, plaintext };
}

export async function exportCredentialTransfer(passphrase: string): Promise<Buffer> {
  return withWorkspaceRecoveryCapture(async () => {
    const records: Record<string, unknown> = {};
    for (const key of STORES) {
      const file = path.join(getWorkspaceDataDir(), 'db', `${key}.json`);
      let bytes: Buffer;
      try {
        bytes = await readPlainFile(file, { maxBytes: 7 * 1024 * 1024,
          verifyPath: () => assertLinkFreeFileParent(getDataDir(), file) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new RecipientTransferError();
      }
      try {
        const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        validateRecord(key, record);
        records[key] = await transform(record, sourceValue);
      }
      finally { bytes.fill(0); }
    }
    const now = Date.now();
    const bytes = Buffer.from(JSON.stringify({ version: 1, createdAt: now, expiresAt: now + LIFETIME_MS, records }));
    try { return await sealRecipientTransfer(bytes, passphrase); }
    finally { bytes.fill(0); }
  });
}

export async function restoreCredentialTransfer(envelope: Uint8Array, transferPassphrase: string,
  workspace: string, localPassphrase: string, options: { signal?: AbortSignal; checkpoint?: (step: string) => Promise<void> } = {}): Promise<string> {
  const name = assertValidWorkspaceName(workspace);
  if (typeof localPassphrase !== 'string' || localPassphrase.length < 12
      || Buffer.byteLength(localPassphrase) > 1024 || localPassphrase === DEFAULT_PASSWORD || localPassphrase === transferPassphrase) throw new RecipientTransferError();
  const plaintext = await openRecipientTransfer(envelope, transferPassphrase);
  let payload: { version: number; createdAt: number; expiresAt: number; records: Record<string, unknown> };
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)); }
  finally { plaintext.fill(0); }
  const now = Date.now();
  if (!payload || payload.version !== 1 || !Number.isSafeInteger(payload.createdAt) || !Number.isSafeInteger(payload.expiresAt)
      || payload.createdAt > now + 60_000 || payload.expiresAt <= now || payload.expiresAt - payload.createdAt !== LIFETIME_MS
      || !payload.records || typeof payload.records !== 'object' || Array.isArray(payload.records)
      || Object.keys(payload.records).some(key => !(STORES as readonly string[]).includes(key))) throw new RecipientTransferError();
  const ring = newKeyring();
  const metadata = await wrapKeyring(ring, 'user', localPassphrase, 'passphrase');
  const prepared = new Map<string, Buffer>();
  for (const [key, record] of Object.entries(payload.records)) {
    validateRecord(key, record);
    const encrypt = async (value: string, credential: boolean) => {
      if (!credential || !value || /^\$\{global:[^}]+\}$/.test(value)) return value;
      const ciphertext = seal(value, ring.activeKey, PURPOSE);
      if (open(ciphertext, ring.activeKey, PURPOSE) !== value) throw new RecipientTransferError();
      return `encrypted:${ciphertext}`;
    };
    const data = key === StorageKey.GLOBAL_ENV_VARS && record && typeof record === 'object' && !Array.isArray(record)
      ? Object.fromEntries(await Promise.all(Object.entries(record).map(async ([variable, value]) => {
        const mapped = await transform(value, encrypt, true, 0, true);
        if (typeof mapped === 'string') return [variable, { value: mapped, metadata: { isSecret: true } }];
        if (!mapped || typeof mapped !== 'object' || typeof (mapped as Record<string, unknown>).value !== 'string') throw new RecipientTransferError();
        return [variable, { ...(mapped as Record<string, unknown>), metadata: { isSecret: true } }];
      })))
      : await transform(record, encrypt, false, 0, true);
    // Transferred MCP configuration is dormant until recipient review.
    if (key === StorageKey.MCP_SERVERS && Array.isArray(data)) {
      for (const server of data) server.disabled = true;
    }
    prepared.set(`${key}.json`, Buffer.from(JSON.stringify(data)));
  }
  prepared.set(`${StorageKey.ENCRYPTION_KEY}.json`, Buffer.from(JSON.stringify(metadata)));
  if ([...prepared.values()].reduce((total, bytes) => total + bytes.length, 0) > MAX_TRANSFER_BYTES * 2) throw new RecipientTransferError();
  options.signal?.throwIfAborted();
  const root = getWorkspacesDir();
  await assertLinkFreeFileParent(getDataDir(), path.join(root, 'probe'));
  const rootIdentity = await fs.lstat(root, { bigint: true });
  const staging = await fs.mkdtemp(path.join(root, '.credential-transfer-'));
  const stageIdentity = await fs.lstat(staging, { bigint: true });
  let published = false;
  try {
    await fs.chmod(staging, 0o700);
    for (const subtree of WORKSPACE_SUBTREES) await fs.mkdir(path.join(staging, subtree), { mode: 0o700 });
    await atomicWriteWithoutLinks(staging, path.join(staging, '.workspace.json'), Buffer.from('{"roots":[]}'), { mode: 0o600 });
    for (const [file, bytes] of prepared) {
      options.signal?.throwIfAborted();
      await atomicWriteWithoutLinks(staging, path.join(staging, 'db', file), bytes, { mode: 0o600 });
      const actual = await readPlainFile(path.join(staging, 'db', file), { maxBytes: MAX_TRANSFER_BYTES * 2, ownerOnly: true });
      try { if (!actual.equals(bytes)) throw new RecipientTransferError(); } finally { actual.fill(0); }
      await options.checkpoint?.('file_written');
    }
    return await withWorkspaceNamespaceMutation(async () => {
      options.signal?.throwIfAborted();
      await assertLinkFreeFileParent(getDataDir(), path.join(root, 'probe'));
      const currentRoot = await fs.lstat(root, { bigint: true });
      const currentStage = await fs.lstat(staging, { bigint: true });
      if (currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino
          || currentStage.dev !== stageIdentity.dev || currentStage.ino !== stageIdentity.ino || currentStage.isSymbolicLink()) throw new RecipientTransferError();
      await options.checkpoint?.('before_publish');
      if ((await fs.readdir(root)).some(entry => entry.toLowerCase() === name.toLowerCase())) throw new RecipientTransferError();
      options.signal?.throwIfAborted();
      await fs.rename(staging, getWorkspaceDir(name));
      published = true;
      if (process.platform !== 'win32') {
        const parent = await fs.open(root, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      return name;
    });
  } finally {
    for (const bytes of prepared.values()) bytes.fill(0);
    if (!published) {
      const current = await fs.lstat(staging, { bigint: true }).catch(() => undefined);
      if (current && current.isDirectory() && !current.isSymbolicLink() && current.dev === stageIdentity.dev && current.ino === stageIdentity.ino
          && path.dirname(staging) === root && path.basename(staging).startsWith('.credential-transfer-')) {
        // Generated staging path is contained beneath the verified workspace root.
        await fs.rm(staging, { recursive: true, force: true });
      }
    }
  }
}
