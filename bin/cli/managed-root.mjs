/**
 * The folder one named instance is run from. It sits outside the data directory,
 * so logs and old versions never end up in a data backup.
 *
 *   <root>/launch.mjs        stays put, so the autostart entry never has to change
 *   <root>/current.json      which package version to run, and the one before it
 *   <root>/service.json      name, data directory, port and start mode
 *   <root>/state.json        what the supervisor is doing right now
 *   <root>/stop-request      present while the instance is meant to stay stopped
 *   <root>/logs/             size-limited log files
 *   <root>/versions/         installed package versions (flujo update)
 *   <root>/backups/          data copies taken before an update (flujo update)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonIfPresent, writeFileAtomicSync, writeJsonAtomicSync } from './common.mjs';

export const packageRootOfThisFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const rootPaths = root => ({
  launcher: path.join(root, 'launch.mjs'),
  current: path.join(root, 'current.json'),
  service: path.join(root, 'service.json'),
  state: path.join(root, 'state.json'),
  lock: path.join(root, 'supervisor.lock'),
  stopRequest: path.join(root, 'stop-request'),
  logs: path.join(root, 'logs'),
  logFile: path.join(root, 'logs', 'flujo.log'),
  versions: path.join(root, 'versions'),
  backups: path.join(root, 'backups'),
  updateLock: path.join(root, 'update.lock'),
  updateJournal: path.join(root, 'update-journal.json'),
});

/**
 * Reads current.json on every start. If the selected version has gone missing it
 * falls back to the previous one, because a missing folder must not leave an
 * instance that nobody can reach switched off for good.
 */
const LAUNCHER_SOURCE = `#!/usr/bin/env node
// Written by "flujo service install". Do not edit: it is replaced on every install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const current = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const entry = directory => path.join(directory, 'bin', 'flujo.mjs');
const selected = [current.packageDir, current.previous?.packageDir]
  .find(directory => typeof directory === 'string' && fs.existsSync(entry(directory)));
if (!selected) {
  console.error('[FLUJO] No installed version could be found in ' + root);
  process.exit(78);
}
if (selected !== current.packageDir) console.error('[FLUJO] The selected version is missing. Starting the previous one.');
await import(pathToFileURL(entry(selected)).href);
`;

export function packageVersion(packageDir) {
  return readJsonIfPresent(path.join(packageDir, 'package.json'))?.version ?? 'unknown';
}

export function readCurrent(root) { return readJsonIfPresent(rootPaths(root).current); }
export function writeCurrent(root, value) { writeJsonAtomicSync(rootPaths(root).current, value); }
export function readServiceRecord(root) { return readJsonIfPresent(rootPaths(root).service); }

/** Create the stable launcher. An existing version choice is never overwritten. */
export function prepareManagedRoot(root, packageDir = packageRootOfThisFile) {
  const paths = rootPaths(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  writeFileAtomicSync(paths.launcher, LAUNCHER_SOURCE, { mode: 0o755 });
  if (!readCurrent(root)) {
    writeCurrent(root, { version: packageVersion(packageDir), packageDir: path.resolve(packageDir) });
  }
  return paths;
}
