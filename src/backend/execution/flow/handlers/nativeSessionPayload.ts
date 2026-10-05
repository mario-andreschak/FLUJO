import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertSafeCollectionId } from '@/utils/storage/backend';
import { getWorkspaceDataDir } from '@/utils/workspace';
import type { NativeInvocationSessionPayload, NativeInvocationSessionPayloadRef } from './nativeInvocationSession';

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
let rootOverride: string | undefined;
export function _setNativeSessionPayloadRootForTests(root: string | undefined): void { rootOverride = root; }
const root = () => rootOverride ?? path.join(getWorkspaceDataDir(), 'db', 'native-session-payloads');
const fileFor = (invocationId: string, sha256: string) => {
  assertSafeCollectionId(invocationId);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid native session payload hash.');
  return path.join(root(), invocationId, `${sha256}.json`);
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Immutable, bounded private material. The reference digest never replaces
 * the receipt's model-input or inventory digest. */
export async function saveNativeSessionPayload(payload: NativeInvocationSessionPayload): Promise<NativeInvocationSessionPayloadRef> {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error('Native session payload exceeds its private archive bound.');
  }
  const sha256 = hash(bytes);
  const target = fileFor(payload.invocationId, sha256);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  // Link publishes without replacing a prior immutable payload. A crash before
  // temp removal leaves nlink > 1, which the reader conservatively rejects.
  try { await fs.link(temp, target); await fs.unlink(temp); }
  catch (error) { await fs.rm(temp, { force: true }).catch(() => undefined); throw error; }
  try {
    const directory = await fs.open(path.dirname(target), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { /* Directory fsync is unavailable on some Windows filesystems. */ }
  return { kind: 'private-native-session-payload', invocationId: payload.invocationId,
    sha256, byteLength: bytes.length };
}

export async function readNativeSessionPayload(ref: NativeInvocationSessionPayloadRef): Promise<NativeInvocationSessionPayload> {
  if (ref.kind !== 'private-native-session-payload' || !Number.isSafeInteger(ref.byteLength)
    || ref.byteLength < 1 || ref.byteLength > MAX_PAYLOAD_BYTES) throw new Error('Invalid native session payload reference.');
  const file = fileFor(ref.invocationId, ref.sha256);
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
    || entry.size !== ref.byteLength) throw new Error('Native session payload reference changed.');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== ref.byteLength) {
      throw new Error('Native session payload changed.');
    }
    const bytes = Buffer.alloc(ref.byteLength + 1);
    let read = 0;
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (read !== ref.byteLength || hash(bytes.subarray(0, read)) !== ref.sha256) {
      throw new Error('Native session payload digest changed.');
    }
    const payload = JSON.parse(bytes.subarray(0, read).toString('utf8')) as NativeInvocationSessionPayload;
    if (payload.invocationId !== ref.invocationId) throw new Error('Native session payload owner changed.');
    return payload;
  } finally { await handle.close(); }
}
