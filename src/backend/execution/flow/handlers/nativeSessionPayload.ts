import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertSafeCollectionId } from '@/utils/storage/backend';
import { getWorkspaceDataDir } from '@/utils/workspace';
import type { NativeInvocationSessionPayload, NativeInvocationSessionPayloadRef } from './nativeInvocationSession';
import { readNativeHeldFile } from './nativeHeldFile';

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
let rootOverride: string | undefined;
export function _setNativeSessionPayloadRootForTests(root: string | undefined): void { rootOverride = root; }
const root = (workspace?: string) => rootOverride ?? path.join(getWorkspaceDataDir(workspace), 'db', 'native-session-payloads');
const fileFor = (invocationId: string, sha256: string, workspace?: string) => {
  assertSafeCollectionId(invocationId);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid native session payload hash.');
  return path.join(root(workspace), invocationId, `${sha256}.json`);
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

export async function readNativeSessionPayload(ref: NativeInvocationSessionPayloadRef, workspace?: string): Promise<NativeInvocationSessionPayload> {
  if (ref.kind !== 'private-native-session-payload' || !Number.isSafeInteger(ref.byteLength)
    || ref.byteLength < 1 || ref.byteLength > MAX_PAYLOAD_BYTES) throw new Error('Invalid native session payload reference.');
  const file = fileFor(ref.invocationId, ref.sha256, workspace);
    const bytes = await readNativeHeldFile(file, ref.byteLength);
    if (bytes.length !== ref.byteLength || hash(bytes) !== ref.sha256) {
      throw new Error('Native session payload digest changed.');
    }
    const payload = JSON.parse(bytes.toString('utf8')) as NativeInvocationSessionPayload;
    if (payload.invocationId !== ref.invocationId) throw new Error('Native session payload owner changed.');
    return payload;
}
