import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isSupportedNodeRuntime } from './node-runtime.mjs';

// Library imports of launch-next.mjs only need its environment helpers.
let entry = path.resolve(process.argv[1] || '');
try { entry = realpathSync.native(entry); } catch { /* Library import without a CLI entry. */ }
const appEntries = ['flujo.mjs', '../scripts/launch-next.mjs']
  .map(file => fileURLToPath(new URL(file, import.meta.url)));
if (appEntries.includes(entry)) {
  if (!isSupportedNodeRuntime(process.versions.node)) {
    // A synchronous boundary prevents sibling ESM dependencies from evaluating
    // while an asynchronous updater waits for consent or downloads Node.
    const updater = fileURLToPath(new URL('node-runtime-update.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [updater, ...process.argv.slice(1)], {
      stdio: 'inherit', windowsHide: true,
    });
    process.exit(result.status ?? 1);
  }
  for (let index = process.argv.length - 1; index >= 2; index--) {
    if (process.argv[index] === '--update-node') process.argv.splice(index, 1);
  }
}
