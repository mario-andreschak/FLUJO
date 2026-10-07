import { createReadStream, promises as fs } from 'node:fs';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { openSnapshotInput } from '@/backend/services/workspace/snapshotInput';
import { openSnapshotDownload, writeSnapshotStream } from '@/backend/services/workspace/snapshotStreaming';
import { inspectSnapshotZip, snapshotMemberChunks } from '@/backend/services/workspace/snapshotZip';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const safe = (name: string, directory = false) => directory ? name.slice(0, -1) : name;
describe('bounded authenticated snapshot transport', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), 'flujo-streaming-test-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const legacy = (bytes: Buffer, key: Buffer) => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return { format: 'flujo-workspace-encrypted', version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  };
  async function fixture(streamed = false) {
    const zip = new JSZip(); zip.file('userdata/member.bin', Buffer.from('intact member bytes'));
    if (!streamed) return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const file = path.join(root, 'streamed.zip');
    await writeSnapshotStream(new Readable().wrap(zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE' })), file, null);
    return fs.readFile(file);
  }
  it.each([false, true])('validates legacy and data-descriptor ZIPs (streamed=%s)', async streamed => {
    const bytes = await fixture(streamed); const file = path.join(root, 'input'); await fs.writeFile(file, bytes);
    const input = await openSnapshotInput(file, undefined, 1024 * 1024, sha(bytes));
    try {
      const members = await inspectSnapshotZip(input, 1024, 1024, safe);
      const member = members.find(item => item.name === 'userdata/member.bin')!;
      const chunks: Buffer[] = []; for await (const chunk of snapshotMemberChunks(input, member)) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('intact member bytes');
    } finally { await input.close(); }
  });
  it.each(['data-first', 'tag-first'])('accepts order-independent old v1 envelope fields (%s)', async order => {
    const bytes = await fixture(); const key = randomBytes(32); const envelope = legacy(bytes, key);
    const ordered = order === 'data-first' ? { data: envelope.data, tag: envelope.tag, iv: envelope.iv, version: 1, format: envelope.format }
      : { tag: envelope.tag, format: envelope.format, version: 1, iv: envelope.iv, data: envelope.data };
    const file = path.join(root, 'envelope'); await fs.writeFile(file, JSON.stringify(ordered));
    const input = await openSnapshotInput(file, key.toString('base64'), 1024 * 1024, sha(bytes));
    try { expect(await input.read(0, bytes.length)).toEqual(bytes); } finally { await input.close(); }
  });
  it.each([false, true])('accepts legal escaped base64 across JSON chunk boundaries (%s)', async boundary => {
    const bytes = await fixture(); const key = randomBytes(32); const envelope = legacy(bytes, key);
    const escaped = envelope.data.split('').map(character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    const encoded = (boundary ? ' '.repeat(65_526) : '') + '{"data":"' + escaped + '","tag":' + JSON.stringify(envelope.tag)
      + ',"iv":' + JSON.stringify(envelope.iv) + ',"version":1,"format":' + JSON.stringify(envelope.format) + '}';
    const file = path.join(root, 'escaped'); await fs.writeFile(file, encoded);
    const input = await openSnapshotInput(file, key.toString('base64'), 1024 * 1024, sha(bytes));
    try { expect(await input.read(0, bytes.length)).toEqual(bytes); } finally { await input.close(); }
  });
  it('contains source errors while output acquisition is pending', async () => {
    const source = new Readable({ read() {} });
    const open = fs.open.bind(fs);
    const acquisition = jest.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      source.destroy(new Error('injected early source failure'));
      await new Promise<void>(resolve => setImmediate(resolve));
      return handle;
    });
    try { await expect(writeSnapshotStream(source, path.join(root, 'early-error'), null)).rejects.toThrow('early source failure'); }
    finally { acquisition.mockRestore(); }
  });
  it('closes a source descriptor when output creation fails', async () => {
    const file = path.join(root, 'existing'); await fs.writeFile(file, 'existing');
    const source = createReadStream(file);
    const closed = new Promise<void>(resolve => source.once('close', resolve));
    await expect(writeSnapshotStream(source, file, null)).rejects.toMatchObject({ code: 'EEXIST' });
    await closed; expect(source.destroyed).toBe(true); await fs.unlink(file);
  });
  it('attempts all cleanup and fails closed when envelope spool removal fails', async () => {
    const bytes = await fixture(); const key = randomBytes(32); const file = path.join(root, 'cleanup');
    await fs.writeFile(file, JSON.stringify(legacy(bytes, key)));
    const remove = fs.rm.bind(fs); let failedPath: string | undefined;
    const spy = jest.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (!failedPath && String(target).includes('flujo-snapshot-envelope-')) { failedPath = String(target); throw new Error('injected cleanup failure'); }
      return remove(target, options);
    });
    try { await expect(openSnapshotInput(file, key.toString('base64'), 1024 * 1024, sha(bytes))).rejects.toThrow('temporary storage'); }
    finally { spy.mockRestore(); if (failedPath) await remove(failedPath, { recursive: true, force: true }); }
  });
  it.each(['tag', 'duplicate', 'unknown', 'padding', 'trailing', 'oversize', 'escape', 'wrong-key'])('rejects %s envelope and removes every owned spool', async kind => {
    const bytes = await fixture(); const key = randomBytes(32); const envelope = legacy(bytes, key);
    let encoded = JSON.stringify(envelope);
    if (kind === 'tag') encoded = JSON.stringify({ ...envelope, tag: randomBytes(16).toString('base64') });
    if (kind === 'duplicate') encoded = encoded.replace('"version":1', '"version":1,"version":1');
    if (kind === 'unknown') encoded = encoded.replace('"version":1', '"version":1,"other":0');
    if (kind === 'padding') encoded = JSON.stringify({ ...envelope, data: `${envelope.data}=A` });
    if (kind === 'trailing') encoded += '{}';
    if (kind === 'escape') encoded = encoded.replace(envelope.data, '\\q');
    const file = path.join(root, 'bad'); await fs.writeFile(file, encoded);
    const allocated: string[] = []; const original = fs.mkdtemp.bind(fs);
    const allocation = jest.spyOn(fs, 'mkdtemp').mockImplementation(async prefix => {
      const directory = await original(prefix); allocated.push(directory); return directory;
    });
    try {
      await expect(openSnapshotInput(file, (kind === 'wrong-key' ? randomBytes(32) : key).toString('base64'), kind === 'oversize' ? bytes.length - 1 : 1024 * 1024, sha(bytes))).rejects.toThrow();
      for (const directory of allocated) await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { allocation.mockRestore(); }
  });
  it('accepts unsigned ZIP data descriptors', async () => {
    const original = await fixture(true);
    const descriptor = original.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
    expect(descriptor).toBeGreaterThan(0);
    const bytes = Buffer.concat([original.subarray(0, descriptor), original.subarray(descriptor + 4)]);
    const end = bytes.length - 22;
    bytes.writeUInt32LE(bytes.readUInt32LE(end + 16) - 4, end + 16);
    const file = path.join(root, 'unsigned'); await fs.writeFile(file, bytes);
    const input = await openSnapshotInput(file, undefined, 1024 * 1024, sha(bytes));
    try {
      const members = await inspectSnapshotZip(input, 1024, 1024, safe);
      const member = members.find(item => item.name === 'userdata/member.bin')!;
      const chunks: Buffer[] = []; for await (const chunk of snapshotMemberChunks(input, member)) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('intact member bytes');
    } finally { await input.close(); }
  });
  it('rejects trailing bytes inside a declared deflate member', async () => {
    const original = await fixture();
    const central = original.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const local = original.readUInt32LE(central + 42);
    const compressed = original.readUInt32LE(central + 20);
    const after = local + 30 + original.readUInt16LE(local + 26) + original.readUInt16LE(local + 28) + compressed;
    const bytes = Buffer.concat([original.subarray(0, after), Buffer.from('junk'), original.subarray(after)]);
    bytes.writeUInt32LE(compressed + 4, local + 18);
    bytes.writeUInt32LE(compressed + 4, central + 4 + 20);
    const end = bytes.length - 22; bytes.writeUInt32LE(bytes.readUInt32LE(end + 16) + 4, end + 16);
    const file = path.join(root, 'trailing-deflate'); await fs.writeFile(file, bytes);
    const input = await openSnapshotInput(file, undefined, 1024 * 1024, sha(bytes));
    try {
      const members = await inspectSnapshotZip(input, 1024, 1024, safe);
      const member = members.find(item => item.name === 'userdata/member.bin')!;
      await expect((async () => { for await (const chunk of snapshotMemberChunks(input, member)) void chunk; })()).rejects.toThrow();
    } finally { await input.close(); }
  });
  it('rejects CRC corruption and nonzero central member disk identity', async () => {
    for (const kind of ['crc', 'disk']) {
      const bytes = await fixture(); const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      if (kind === 'crc') { bytes.writeUInt32LE(123, central + 16); bytes.writeUInt32LE(123, bytes.readUInt32LE(central + 42) + 14); }
      else bytes.writeUInt16LE(1, central + 34);
      const file = path.join(root, kind); await fs.writeFile(file, bytes);
      const input = await openSnapshotInput(file, undefined, 1024 * 1024, sha(bytes));
      try {
        if (kind === 'disk') await expect(inspectSnapshotZip(input, 1024, 1024, safe)).rejects.toThrow();
        else {
          const members = await inspectSnapshotZip(input, 1024, 1024, safe);
          await expect((async () => { for (const member of members) for await (const chunk of snapshotMemberChunks(input, member)) void chunk; })()).rejects.toThrow();
        }
      } finally { await input.close(); }
    }
  });
  it.each(['mutate', 'abort', 'expire'])('refuses an interrupted delivered stream (%s)', async kind => {
    const bytes = randomBytes(2 * 1024 * 1024); const file = path.join(root, 'download'); await fs.writeFile(file, bytes);
    const controller = new AbortController(); let expired = false;
    const stream = await openSnapshotDownload(file, bytes.length, sha(bytes), controller.signal, () => { if (expired) throw new Error('expired'); });
    const reader = stream.getReader(); expect((await reader.read()).done).toBe(false);
    if (kind === 'mutate') { const target = await fs.open(file, 'r+'); try { await target.write(Buffer.from('changed'), 0, 7, bytes.length - 7); } finally { await target.close(); } }
    else if (kind === 'abort') controller.abort(); else expired = true;
    await expect((async () => { while (!(await reader.read()).done) {} })()).rejects.toThrow();
  });
  it('cancels a download before consuming any data and releases its descriptor', async () => {
    const bytes = randomBytes(1024); const file = path.join(root, 'cancel'); await fs.writeFile(file, bytes);
    const stream = await openSnapshotDownload(file, bytes.length, sha(bytes), new AbortController().signal, () => undefined);
    await stream.cancel(); await fs.unlink(file);
  });
});
