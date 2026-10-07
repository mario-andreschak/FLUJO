import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
assert.ok(['natural', 'child', 'orphan', 'held', 'output'].includes(mode));
if (mode === 'child') {
  setTimeout(() => console.log('synthetic child terminal'), 50);
} else if (mode === 'held') {
  setTimeout(() => console.log('held fixture unexpectedly completed'), 60_000);
} else if (mode === 'output') {
  process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 120));
} else {
  if (createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
      !== '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e') {
    throw new Error('Node changed immediately before native fixture child entry');
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode === 'natural' ? 'child' : 'held'],
    { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  child.once('error', () => { process.exitCode = 1; });
  if (mode === 'natural') child.once('close', code => { assert.equal(code, 0); console.log('synthetic original root terminal'); });
  else child.once('spawn', () => process.exit(0));
}
