import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertPrivateDirectory, assertPrivateFile } from './private-storage.js';

/** Kernel-backed SQLite lock, released on crash. No stale PID files or lock deletion. */
export function lockController(directory: string): () => void {
  assertPrivateDirectory(directory);
  const filename = join(directory, 'controller-process.sqlite');
  if (!existsSync(filename)) closeSync(openSync(filename, 'wx', 0o600));
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(filename + suffix)) assertPrivateFile(filename + suffix);
  }
  const lock = new DatabaseSync(filename);
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS controller_lock (id INTEGER);');
  } catch { lock.close(); throw new Error('Another controller owns this state directory.'); }
  return () => { lock.exec('ROLLBACK'); lock.close(); };
}
