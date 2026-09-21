import JSZip from 'jszip';
import {
  decodePersonaRecoveryZip, encodePersonaRecoveryZip, PERSONA_RECOVERY_ZIP_LIMITS,
} from '@/backend/services/enduringAgents/personaRecoveryZip';

async function fixture() {
  return encodePersonaRecoveryZip([
    { path: 'persona-recovery-manifest.json', bytes: Buffer.from('{"formatVersion":1}') },
    { path: 'home/persona_a/记忆.txt', bytes: Buffer.from('Private memory. '.repeat(100)) },
    { path: 'records/personas/persona_a.json', bytes: Buffer.from('{"id":"persona_a"}') },
  ]);
}

function central(bytes: Buffer): number { return bytes.readUInt32LE(bytes.length - 6); }

it('round-trips Unicode paths, empty files and private source bytes without directory entries', async () => {
  const files = [
    { path: 'home/persona_a/记忆.txt', bytes: Buffer.from('Private memory') },
    { path: 'records/personas/persona_a.json', bytes: Buffer.from('{"id":"persona_a"}') },
    { path: 'home/persona_a/empty', bytes: Buffer.alloc(0) },
  ];
  const bytes = await encodePersonaRecoveryZip(files);
  expect(decodePersonaRecoveryZip(bytes)).toEqual(files);
});

it.each([
  '../outside', 'home/../outside', '/home/private', 'home\\private', 'home/persona_a/con.txt',
  'home/persona_a/secret:stream', 'home/persona_a/file.', 'home/persona_a/file ',
  'models/secret.json', 'home/persona_a/cafe\u0301.txt', 'home/persona_a/file\u0000',
])('rejects unsafe writer path %j', async (path) => {
  await expect(encodePersonaRecoveryZip([{ path, bytes: Buffer.alloc(0) }])).rejects.toThrow('path');
});

it.each([
  ['home/persona_a/File', 'home/persona_a/file'],
  ['home/persona_a/file', 'home/persona_a/file/child'],
  ['home/persona_a/file/child', 'home/persona_a/file'],
])('rejects duplicate or file/directory aliases before extraction (%s)', async (first, second) => {
  const zip = new JSZip();
  for (const path of [first, second]) zip.file(path, 'private', { createFolders: false });
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  expect(() => decodePersonaRecoveryZip(bytes)).toThrow(/duplicate|conflicting/);
});

it('rejects traversal from an archive rather than relying on JSZip path normalization', async () => {
  const zip = new JSZip();
  zip.file('home/../../outside', 'private', { createFolders: false });
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  expect(() => decodePersonaRecoveryZip(bytes)).toThrow('path');
});

it.each([
  ['local filename', (bytes: Buffer) => { bytes[30] ^= 1; }],
  ['local size', (bytes: Buffer) => { bytes.writeUInt32LE(1, 22); }],
  ['local compression', (bytes: Buffer) => { bytes.writeUInt16LE(99, 8); }],
  ['local CRC', (bytes: Buffer) => { bytes.writeUInt32LE(0, 14); }],
  ['local offset', (bytes: Buffer) => { bytes.writeUInt32LE(1, central(bytes) + 42); }],
  ['encryption', (bytes: Buffer) => { bytes.writeUInt16LE(1, central(bytes) + 8); }],
  ['data descriptor', (bytes: Buffer) => { bytes.writeUInt16LE(8, central(bytes) + 8); }],
  ['link', (bytes: Buffer) => { bytes.writeUInt32LE((0o120600 << 16) >>> 0, central(bytes) + 38); }],
  ['split volume', (bytes: Buffer) => { bytes.writeUInt16LE(1, bytes.length - 18); }],
  ['ZIP64', (bytes: Buffer) => { bytes.writeUInt16LE(0xffff, bytes.length - 12); }],
])('rejects unsupported or inconsistent %s metadata', async (_label, corrupt) => {
  const bytes = await fixture();
  corrupt(bytes);
  expect(() => decodePersonaRecoveryZip(bytes)).toThrow();
});

it('caps declared member count, expanded sizes and compressed upload size', async () => {
  const bytes = await fixture();
  for (const limits of [
    { ...PERSONA_RECOVERY_ZIP_LIMITS, members: 2 },
    { ...PERSONA_RECOVERY_ZIP_LIMITS, fileBytes: 10 },
    { ...PERSONA_RECOVERY_ZIP_LIMITS, totalBytes: 20 },
    { ...PERSONA_RECOVERY_ZIP_LIMITS, archiveBytes: bytes.length - 1 },
  ]) expect(() => decodePersonaRecoveryZip(bytes, limits)).toThrow();
});

it('permits the opaque previous archive above the ordinary file cap while enforcing the shared total', async () => {
  const bytes = Buffer.alloc(100, 65);
  const archive = await encodePersonaRecoveryZip([{ path: 'evidence/recovery-source.zip', bytes }]);
  const limits = { ...PERSONA_RECOVERY_ZIP_LIMITS, fileBytes: 10, totalBytes: 100 };
  expect(decodePersonaRecoveryZip(archive, limits)[0].bytes).toEqual(bytes);
  expect(() => decodePersonaRecoveryZip(archive, { ...limits, totalBytes: 99 })).toThrow('uncompressed size');
  const ordinary = await encodePersonaRecoveryZip([{ path: 'home/persona_a/source.zip', bytes }]);
  expect(() => decodePersonaRecoveryZip(ordinary, limits)).toThrow('member exceeds');
});

it('stops inflation at the declared bound when both ZIP headers lie about expanded size', async () => {
  const bytes = await encodePersonaRecoveryZip([{ path: 'home/persona_a/bomb', bytes: Buffer.alloc(1_000_000, 65) }]);
  bytes.writeUInt32LE(4, 22);
  bytes.writeUInt32LE(4, central(bytes) + 24);
  expect(() => decodePersonaRecoveryZip(bytes)).toThrow();
});

it('checks expanded content CRC instead of trusting matching header CRCs', async () => {
  const zip = new JSZip();
  zip.file('home/persona_a/plain', 'private', { createFolders: false });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const start = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  bytes[start] ^= 1;
  expect(() => decodePersonaRecoveryZip(bytes)).toThrow('checksum');
});

it('rejects unindexed trailing bytes rather than accepting a second archive view', async () => {
  const bytes = Buffer.concat([await fixture(), Buffer.from('trailing')]);
  expect(() => decodePersonaRecoveryZip(bytes)).toThrow();
});
