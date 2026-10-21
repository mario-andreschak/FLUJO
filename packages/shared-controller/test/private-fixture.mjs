import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPrivateDirectory } from '../dist/private-storage.js';

// Release-only: invoke suites through flujo-bash so their fixture cleanup uses
// the required MCP. Register database/process closers in disposal order.
export function privateFixture(t) {
  const directory = createPrivateDirectory(join(homedir(), `.flujo-controller-test-${randomUUID()}`));
  const mask = process.umask(0o077);
  const close = [];
  t.after(async () => {
    try { for (const dispose of close) await dispose(); }
    finally { process.umask(mask); rmSync(directory, { recursive: true, force: true }); }
  });
  return { directory, close };
}
