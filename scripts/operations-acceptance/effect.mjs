// One real disposable disk effect, invoked through the shipped Bash app.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [directory, marker] = process.argv.slice(2);
assert.ok(directory && path.isAbsolute(directory), 'An absolute disposable fixture directory is required.');
assert.match(marker, /^[a-z0-9-]{1,64}$/);
const metadata = await fs.lstat(directory);
assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'The fixture directory must be a real directory.');
await fs.appendFile(path.join(directory, 'effects.jsonl'), `${JSON.stringify({ marker, pid: process.pid })}\n`, { mode: 0o600 });
console.log('Synthetic effect recorded.');
