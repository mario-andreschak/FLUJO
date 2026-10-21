// Fixed helper inside the immutable runtime image. The normal container mounts
// authority read-only; only fixed one-shot local lifecycle helpers can write.
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, closeSync, constants, existsSync, fchownSync, fstatSync, fsyncSync, lstatSync,
  openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { authorityRecordSchema as record, authorityRotationSchema, rotatingAuthority } from './authority-record.js';
const filename = '/run/flujo-owner/owner.json';
const authorityDirectory = '/run/flujo-owner';

function existingAuthority() {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 1000 || (stat.mode & 0o077) !== 0
      || stat.size > 4096) throw new Error('Invalid authority.');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (stat.dev !== opened.dev || stat.ino !== opened.ino || opened.size !== stat.size) throw new Error('Authority changed.');
    const bytes = Buffer.alloc(4097); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd); const named = lstatSync(filename);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
        || named.dev !== stat.dev || named.ino !== stat.ino) throw new Error('Authority changed while reading.');
    return record.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
  } finally { closeSync(fd); }
}

function publishAuthority(policy: ReturnType<typeof record.parse>, expected?: ReturnType<typeof record.parse>) {
  const candidate = `${authorityDirectory}/.candidate-${randomBytes(16).toString('hex')}`;
  const fd = openSync(candidate, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(policy) + '\n'); fchownSync(fd, 1000, 1000); fsyncSync(fd); }
  finally { closeSync(fd); }
  if (expected ? JSON.stringify(existingAuthority()) !== JSON.stringify(expected) : existsSync(filename)) {
    throw new Error('Authority changed before publication.');
  }
  renameSync(candidate, filename);
  const directory = openSync(authorityDirectory, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
  if (JSON.stringify(existingAuthority()) !== JSON.stringify(policy)) throw new Error('Authority publication unconfirmed.');
}

async function input(): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error('Authority input too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function report(policy: ReturnType<typeof record.parse>) {
  process.stdout.write(JSON.stringify({ actorId: policy.ownerId, digest: policy.credentials[0].digest,
    expiresAt: policy.credentials[0].expiresAt, issuedAt: policy.credentials[0].issuedAt }) + '\n');
}

try {
  if (process.argv.length === 3 && process.argv[2] === 'initialize' && process.getuid?.() === 0) {
    const policy = record.parse(await input());
    if (policy.credentials[0].expiresAt <= Date.now() || policy.credentials[0].issuedAt > Date.now()) throw new Error('Invalid validity window.');
    for (const directory of ['/app/data', '/owner-home', '/run/flujo-owner']) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid volume.');
      chownSync(directory, 1000, 1000); chmodSync(directory, 0o700);
    }
    if (existsSync(filename)) {
      if (JSON.stringify(existingAuthority()) !== JSON.stringify(policy)) {
        throw new Error('Existing authority must not be overwritten.');
      }
    } else {
      publishAuthority(policy);
    }
    chownSync(filename, 1000, 1000);
    const persisted = openSync(filename, 'r');
    try { fsyncSync(persisted); } finally { closeSync(persisted); }
    const directory = openSync('/run/flujo-owner', 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    process.stdout.write('initialized\n');
  } else if (process.argv.length === 3 && process.argv[2] === 'rotate' && process.getuid?.() === 1000) {
    const directory = lstatSync(authorityDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 1000 || (directory.mode & 0o077)) {
      throw new Error('Invalid authority directory.');
    }
    const request = authorityRotationSchema.parse(await input());
    if (request.next.credentials[0].issuedAt > Date.now()) throw new Error('Invalid authority time.');
    const current = existingAuthority();
    // An expired interrupted target may be finalized while stopped, then replaced
    // by a fresh rotation. It never grants admission or restarts the runtime.
    if (rotatingAuthority(current, request) === 'replace') publishAuthority(request.next, current);
    report(existingAuthority());
  } else if (process.argv.length === 2 && process.getuid?.() === 1000) {
    report(existingAuthority());
  } else throw new Error('Invalid authority operation.');
} catch { process.stderr.write('Local runtime authority unavailable.\n'); process.exitCode = 1; }
