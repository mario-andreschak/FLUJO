import { linkSync, mkdtempSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function readReleaseState(filename) {
  let bytes;
  try {
    bytes = readFileSync(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const state = JSON.parse(bytes);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid record');
    return state;
  } catch {
    throw new Error('The pending release record is invalid; resolve it before continuing.');
  }
}

// Git provides this path inside its trusted metadata directory. Publish a complete
// record from an exclusively created sibling, so updates replace a directory entry
// instead of truncating a destination that might have become a link.
export function writeReleaseState(filename, state, { createOnly = false } = {}) {
  const destination = path.resolve(filename);
  const directory = mkdtempSync(path.join(path.dirname(destination), '.flujo-release-'));
  const temporary = path.join(directory, 'state.json');
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600, flush: true });
    if (createOnly) linkSync(temporary, destination);
    else renameSync(temporary, destination);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(directory);
  }
}
