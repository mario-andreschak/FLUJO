// Fixed helper inside the immutable runtime image. The normal container mounts
// authority read-only; only the one-shot, local provisioning container can write.
import { chmodSync, chownSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const record = z.object({ schemaVersion: z.literal(1), ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  credentials: z.tuple([z.object({ id: z.literal('local-controller'), digest: z.string().regex(/^[a-f0-9]{64}$/),
    scopes: z.tuple([z.literal('openai:read'), z.literal('openai:execute'), z.literal('mcp:access'),
      z.literal('control:admin'), z.literal('secrets:read'), z.literal('avatar:voice')]),
    issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(), revokedAt: z.null() }).strict()]),
}).strict();
const filename = '/run/flujo-owner/owner.json';

try {
  if (process.argv.length === 3 && process.argv[2] === 'initialize' && process.getuid?.() === 0) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 4096) throw new Error('Initialization input too large.');
      chunks.push(chunk);
    }
    const policy = record.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (policy.credentials[0].expiresAt <= Date.now() || policy.credentials[0].issuedAt > Date.now()) throw new Error('Invalid validity window.');
    for (const directory of ['/app/data', '/owner-home', '/run/flujo-owner']) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid volume.');
      chownSync(directory, 1000, 1000); chmodSync(directory, 0o700);
    }
    if (existsSync(filename)) {
      const current = lstatSync(filename);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.size > 4096
          || JSON.stringify(record.parse(JSON.parse(readFileSync(filename, 'utf8')))) !== JSON.stringify(policy)) {
        throw new Error('Existing authority must not be overwritten.');
      }
    } else {
      const fd = openSync(filename, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(policy) + '\n'); fsyncSync(fd); }
      finally { closeSync(fd); }
    }
    chownSync(filename, 1000, 1000);
    const persisted = openSync(filename, 'r');
    try { fsyncSync(persisted); } finally { closeSync(persisted); }
    const directory = openSync('/run/flujo-owner', 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    process.stdout.write('initialized\n');
  } else if (process.argv.length === 2 && process.getuid?.() === 1000) {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 1000 || (stat.mode & 0o077) !== 0
        || stat.size > 4096) throw new Error('Invalid authority.');
    const policy = record.parse(JSON.parse(readFileSync(filename, 'utf8')));
    process.stdout.write(JSON.stringify({ actorId: policy.ownerId, digest: policy.credentials[0].digest,
      expiresAt: policy.credentials[0].expiresAt, issuedAt: policy.credentials[0].issuedAt }) + '\n');
  } else throw new Error('Invalid authority operation.');
} catch { process.stderr.write('Local runtime authority unavailable.\n'); process.exitCode = 1; }
