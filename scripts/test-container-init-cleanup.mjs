// Fault injection uses a real owned Docker container, then discards its creation reply.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const image = process.argv[2];
assert.ok(process.argv.length === 3 && image && !image.startsWith('-'), 'Usage: node scripts/test-container-init-cleanup.mjs IMAGE');
const run = childProcess.execFileSync;
const failure = new Error('Injected loss of Docker creation reply');
let owner;
let created;
childProcess.execFileSync = (file, args, options) => {
  const value = run(file, args, options);
  if (file === 'docker' && args[0] === 'run') {
    created = String(value).trim();
    owner = args[args.indexOf('--label') + 1];
    throw failure;
  }
  return value;
};
syncBuiltinESMExports();
const probe = new URL('./test-container-init.mjs', import.meta.url);
process.argv = [process.execPath, fileURLToPath(probe), image];
let observed;
try { await import(probe); } catch (error) { observed = error; }
assert.equal(observed, failure, 'Probe did not preserve the injected creation failure');
assert.match(created, /^[a-f0-9]{64}$/);
assert.ok(owner.startsWith('io.flujo.init-test-owner='));
const remaining = run('docker', ['ps', '--all', '--filter', `label=${owner}`, '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 30_000 }).trim();
assert.equal(remaining, '', 'Lost-reply fixture leaked an owned container');
console.log(JSON.stringify({ injectedFailure: failure.message, createdContainer: created, recoveredCleanup: 'verified owner/image, no container remains' }));
