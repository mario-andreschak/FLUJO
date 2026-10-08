import { constants, promises as fs, type BigIntStats } from 'node:fs';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { SNAPSHOT_ENCRYPTION, getSnapshotLimits } from './snapshotTransfer';
import { Readable } from 'node:stream';

/** Persist only wire bytes; ZIP and base64 chunks never become whole-archive strings. */
export async function writeSnapshotStream(source: Readable, destination: string, key: Buffer | null, signal?: AbortSignal) {
  const observeError = () => undefined;
  source.on('error', observeError);
  const wireHash = createHash('sha256');
  const plainHash = createHash('sha256');
  let setup;
  try {
    const limits = getSnapshotLimits();
    const iv = key ? randomBytes(12) : undefined;
    const cipher = key ? createCipheriv('aes-256-gcm', key, iv!) : undefined;
    if (cipher) cipher.setAAD(Buffer.from(SNAPSHOT_ENCRYPTION.v2Aad));
    signal?.throwIfAborted();
    const output = await fs.open(destination, 'wx', 0o600);
    setup = { limits, iv, cipher, output };
  }
  catch (error) { source.destroy(); throw error; }
  const { limits, iv, cipher, output } = setup;
  let plaintextSize = 0;
  let carry = Buffer.alloc(0);
  let size = 0;
  const write = async (bytes: Buffer) => {
    signal?.throwIfAborted();
    if (size + bytes.length > (key ? limits.maxEncryptedBytes : limits.maxArchiveBytes)) throw new Error('Snapshot exceeds the archive size limit.');
    for (let offset = 0; offset < bytes.length;) {
      const result = await output.write(bytes, offset, bytes.length - offset);
      if (!result.bytesWritten) throw new Error('Snapshot write made no progress.');
      offset += result.bytesWritten;
    }
    wireHash.update(bytes);
    size += bytes.length;
  };
  const encode = async (bytes: Buffer, final = false) => {
    const joined = carry.length ? Buffer.concat([carry, bytes]) : bytes;
    const end = final ? joined.length : joined.length - joined.length % 3;
    // JSZip emits small chunks; also cap conversions when supplied another source.
    for (let offset = 0; offset < end;) {
      const length = Math.min(48 * 1024, end - offset);
      await write(Buffer.from(joined.subarray(offset, offset + length).toString('base64')));
      offset += length;
    }
    carry = Buffer.from(joined.subarray(end));
  };
  const abort = () => source.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Snapshot aborted.'));
  signal?.addEventListener('abort', abort, { once: true });
  let primaryFailure = false;
  try {
    signal?.throwIfAborted();
    if (iv) await write(Buffer.from(`{"format":"flujo-workspace-encrypted","version":2,"iv":"${iv.toString('base64')}","data":"`));
    for await (const value of source) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      plaintextSize += bytes.length;
      if (plaintextSize > limits.maxArchiveBytes) throw new Error('Snapshot exceeds the archive size limit.');
      plainHash.update(bytes);
      if (cipher) await encode(cipher.update(bytes));
      else await write(bytes);
    }
    if (cipher) {
      await encode(cipher.final(), true);
      await write(Buffer.from(`","tag":"${cipher.getAuthTag().toString('base64')}"}`));
    }
    await output.sync();
    return { sha256: wireHash.digest('hex'), plaintextSha256: plainHash.digest('hex'), size };
  } catch (error) { primaryFailure = true; throw error; } finally {
    signal?.removeEventListener('abort', abort);
    source.destroy();
    try { await output.close(); } catch (error) { if (!primaryFailure) throw error; }
  }
}

export async function openSnapshotDownload(filename: string, expectedSize: number, expectedHash: string,
  signal: AbortSignal, checkSession: () => void) {
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= file.close();
  let handedOff = false;
  try {
    const initial = await file.stat({ bigint: true });
    const same = (value: BigIntStats) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink']
      .every(field => initial[field as keyof BigIntStats] === value[field as keyof BigIntStats]);
    const verify = async () => {
      signal.throwIfAborted(); checkSession();
      const named = await fs.lstat(filename, { bigint: true });
      if (!initial.isFile() || initial.nlink !== BigInt(1) || !named.isFile() || named.isSymbolicLink()
          || initial.size !== BigInt(expectedSize) || !same(named) || !same(await file.stat({ bigint: true }))) {
        throw new Error('Snapshot archive failed its integrity check.');
      }
    };
    const read = async (position: number) => {
      const bytes = Buffer.alloc(Math.min(64 * 1024, expectedSize - position));
      for (let offset = 0; offset < bytes.length;) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, position + offset);
        if (!bytesRead) throw new Error('Snapshot archive failed its integrity check.');
        offset += bytesRead;
      }
      return bytes;
    };
    await verify(); const hash = createHash('sha256');
    for (let position = 0; position < expectedSize; position += 64 * 1024) {
      signal.throwIfAborted(); checkSession(); hash.update(await read(position));
    }
    await verify();
    if (hash.digest('hex') !== expectedHash) throw new Error('Snapshot archive failed its integrity check.');
    const stream = Readable.from((async function* () {
      try {
        const delivered = createHash('sha256');
        for (let position = 0; position < expectedSize; position += 64 * 1024) {
          await verify(); const bytes = await read(position); delivered.update(bytes); yield bytes;
        }
        await verify();
        if (delivered.digest('hex') !== expectedHash) throw new Error('Snapshot archive failed its integrity check.');
      } finally { await close(); }
    })(), { objectMode: false, highWaterMark: 64 * 1024 });
    const abort = () => stream.destroy(new Error('Snapshot session is no longer available.'));
    stream.on('error', () => undefined);
    stream.once('close', () => {
      signal.removeEventListener('abort', abort);
      void close().catch(() => undefined);
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    handedOff = true;
    return Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array>;
  } finally { if (!handedOff) await close(); }
}
