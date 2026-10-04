import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// No workspace, existing user file, environment credential, or file content is
// read. Device values are diagnostic metadata for files this process creates.
const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'];
const summarize = (stats) => Object.fromEntries(fields.map((field) => [field, stats[field].toString()]));
const differences = (a, b, selected = fields) => selected.filter((field) => a[field] !== b[field]);
const tempParent = path.resolve(os.tmpdir());
const root = await fs.mkdtemp(path.join(tempParent, 'flujo-owned-fs-identity-'));
const relativeRoot = path.relative(tempParent, root);
if (!relativeRoot || relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) throw new Error('Allocated probe root is outside temporary parent');
const rootIdentity = await fs.lstat(root, { bigint: true });
const samples = [];
const created = [];
let cleaned = false;
let probeFailure;
let cleanupFailure;
class ProbeRefusal extends Error {
  constructor(code) { super(code); this.code = code; }
}
async function assertOwnedRoot() {
  const now = await fs.lstat(root, { bigint: true });
  if (!now.isDirectory() || now.isSymbolicLink() || differences(rootIdentity, now, ['dev', 'ino', 'mode', 'uid', 'gid']).length) {
    throw new ProbeRefusal('probe-directory-changed');
  }
}
try {
  for (let index = 0; index < 6; index++) {
    await assertOwnedRoot();
    const leaf = path.join(root, `owned-${index}.json`);
    const writer = await fs.open(leaf, 'wx', 0o600);
    let writable, namedWhileOpen, closedNamed, readerDescriptor, readerNamed;
    let writerClosed = false;
    try {
      await writer.writeFile('{"probe":true}\n', 'utf8');
      await writer.sync();
      // Bind both handles before pathname observations. No reopen relies on a
      // previous path check; all later observations refer to this created inode.
      const reader = await fs.open(leaf, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        writable = await writer.stat({ bigint: true });
        const openedReader = await reader.stat({ bigint: true });
        if (!openedReader.isFile() || openedReader.isSymbolicLink() || openedReader.nlink !== BigInt(1)
            || differences(writable, openedReader, ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size']).length) {
          throw new ProbeRefusal('descriptor-binding');
        }
        namedWhileOpen = await fs.lstat(leaf, { bigint: true });
        await writer.close();
        writerClosed = true;
        closedNamed = await fs.lstat(leaf, { bigint: true });
        created.push({ leaf, namedIdentity: closedNamed });
        readerDescriptor = await reader.stat({ bigint: true });
        readerNamed = await fs.lstat(leaf, { bigint: true });
        // Deliberately do not read bytes or treat mismatched metadata as safe.
      } finally {
        await reader.close();
      }
    } finally {
      if (!writerClosed) await writer.close();
    }
    const closedBindingDifferences = differences(writable, closedNamed, ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size']);
    const readerDifferences = differences(readerDescriptor, readerNamed);
    samples.push({
      index, writableDescriptor: summarize(writable), namedWhileOpen: summarize(namedWhileOpen),
      closedNamed: summarize(closedNamed), readerDescriptor: summarize(readerDescriptor), readerNamed: summarize(readerNamed),
      closedBindingDifferences, readerDifferences,
      allRegularSingleLink: [writable, closedNamed, readerDescriptor, readerNamed].every(s => s.isFile() && !s.isSymbolicLink() && s.nlink === BigInt(1)),
      // This relation is recorded only to investigate upstream libuv's fix.
      // It is never used to admit, compare as equivalent, read, or delete a file.
      diagnosticLow32DeviceRelation: BigInt.asUintN(32, closedNamed.dev) === writable.dev,
    });
  }
} catch (error) {
  probeFailure = error instanceof ProbeRefusal ? error.code : 'probe-io-error';
} finally {
  // Remove only known allocated leaves after fresh path-to-path identity checks.
  // No recursive deletion, masking, repair, or unknown-entry cleanup occurs.
  try {
    await assertOwnedRoot();
    for (const { leaf, namedIdentity } of created) {
      const now = await fs.lstat(leaf, { bigint: true });
      if (!now.isFile() || now.isSymbolicLink() || now.nlink !== BigInt(1) || differences(namedIdentity, now).length) {
        throw new ProbeRefusal('probe-leaf-changed');
      }
      await fs.unlink(leaf);
    }
    await assertOwnedRoot();
    await fs.rmdir(root);
    cleaned = true;
  } catch (error) {
    cleanupFailure = error instanceof ProbeRefusal ? error.code
      : error?.code === 'ENOTEMPTY' ? 'probe-unknown-entry-preserved' : 'probe-cleanup-io-error';
  }
}
const identityContractSatisfied = !probeFailure && samples.length === 6 && samples.every(s => s.allRegularSingleLink
  && !s.closedBindingDifferences.length && !s.readerDifferences.length);
console.log(JSON.stringify({
  schemaVersion: 1, kind: 'owned-temporary-file-identity-contract', createdAt: new Date().toISOString(),
  runtime: { node: process.version, libuv: process.versions.uv, platform: process.platform, architecture: process.arch,
    osRelease: os.release(), osVersion: os.version() },
  samples, identityContractSatisfied, cleanupCompleted: cleaned, probeFailure, cleanupFailure, existingUserFilesRead: false,
  productionAdmissionChanged: false, installedStartupQualified: false,
}, null, 2));
if (!identityContractSatisfied || !cleaned) process.exitCode = 1;
