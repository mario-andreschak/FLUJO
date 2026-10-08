import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { provisionOwnerBootstrap } from './owner-bootstrap.mjs';

test('local CLI issues a private expiring capability without printing secret bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-pair-cli-'));
  try {
    const directory = path.join(root, 'owner');
    const child = spawnSync(process.execPath, [path.resolve('scripts/owner-bootstrap.mjs'), directory, 'owner'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0); assert.equal(child.stderr, '');
    const result = JSON.parse(child.stdout);
    const token = fs.readFileSync(result.pairingTokenFile, 'utf8');
    const grant = JSON.parse(fs.readFileSync(result.bootstrapFile, 'utf8'));
    assert.match(token, /^flo_v1_[A-Za-z0-9_-]{43}$/);
    assert.equal(grant.credentials[0].digest, createHash('sha256').update(token).digest('hex'));
    assert.equal(grant.credentials[0].expiresAt - grant.credentials[0].issuedAt, 900_000);
    assert.equal(fs.existsSync(result.policyFile), false);
    assert.equal(child.stdout.includes(token), false);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(result.pairingTokenFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(result.bootstrapFile).mode & 0o777, 0o600);
    }
    const before = fs.readFileSync(result.bootstrapFile);
    assert.throws(() => provisionOwnerBootstrap(directory, 'replacement'));
    assert.deepEqual(fs.readFileSync(result.bootstrapFile), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('invalid or relative provisioning inputs have no filesystem effects', () => {
  assert.throws(() => provisionOwnerBootstrap('relative-directory', 'owner'));
  assert.throws(() => provisionOwnerBootstrap(path.resolve('unused-pairing-directory'), '../owner'));
});

test('provisioning refuses data-directory secrets before creating any file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-pair-cli-data-'));
  const previous = process.env.FLUJO_DATA_DIR; const parent = process.env.FLUJO_PARENT_DATA_DIR;
  try {
    process.env.FLUJO_DATA_DIR = root; delete process.env.FLUJO_PARENT_DATA_DIR;
    const directory = path.join(root, 'owner');
    assert.throws(() => provisionOwnerBootstrap(directory, 'owner'));
    assert.equal(fs.existsSync(directory), false);
  } finally {
    if (previous === undefined) delete process.env.FLUJO_DATA_DIR; else process.env.FLUJO_DATA_DIR = previous;
    if (parent === undefined) delete process.env.FLUJO_PARENT_DATA_DIR; else process.env.FLUJO_PARENT_DATA_DIR = parent;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
