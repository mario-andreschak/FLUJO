import fs, { type BigIntStats } from 'node:fs';
import path from 'node:path';

export class RuntimeDirectoryAdmissionError extends Error {
  readonly code = 'UNSAFE_MCP_RUNTIME_DIRECTORY';

  constructor() {
    super('Isolated MCP runtime directory is unavailable or unsafe.');
    this.name = 'RuntimeDirectoryAdmissionError';
  }
}

interface AdmittedDirectory {
  stat: BigIntStats;
  canonical: string;
  privateAnchor: boolean;
}

function validateDirectory(stat: BigIntStats, privateAnchor: boolean): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeDirectoryAdmissionError();
  if (process.platform !== 'win32') {
    const uid = process.geteuid?.() ?? process.getuid?.();
    if (uid === undefined || stat.uid !== BigInt(uid)
        || (privateAnchor ? (stat.mode & BigInt(0o777)) !== BigInt(0o700)
          : (stat.mode & BigInt(0o022)) !== BigInt(0))) {
      throw new RuntimeDirectoryAdmissionError();
    }
  }
}

/**
 * Admit a selected workspace and its runtime descendants before environment
 * handoff. These path rechecks are not descriptor-relative creation or an OS
 * sandbox. The per-server anchor supplies privacy; shared containers may be0755.
 */
export class RuntimeDirectoryAdmission {
  private readonly root: string;
  private readonly directories = new Map<string, AdmittedDirectory>();

  constructor(workspaceRoot: string) {
    try {
      this.root = path.resolve(workspaceRoot);
      const stat = fs.lstatSync(this.root, { bigint: true });
      validateDirectory(stat, false);
      this.directories.set(this.root, { stat, canonical: fs.realpathSync(this.root), privateAnchor: false });
      this.verify();
    } catch {
      throw new RuntimeDirectoryAdmissionError();
    }
  }

  /** Create only a direct child of an admitted parent; never recreate the workspace. */
  admit(directory: string, privateAnchor = false): void {
    try {
      this.verify();
      const candidate = path.resolve(directory);
      const parent = this.directories.get(path.dirname(candidate));
      if (candidate === this.root || !parent) throw new RuntimeDirectoryAdmissionError();
      const previous = this.directories.get(candidate);
      if (previous) {
        // Repeated parent visits retain their original identity and strictness.
        if (privateAnchor && !previous.privateAnchor) {
          validateDirectory(previous.stat, true);
          previous.privateAnchor = true;
        }
        return;
      }

      let stat: BigIntStats | undefined;
      try {
        stat = fs.lstatSync(candidate, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!stat) {
        // mkdir without recursive is exclusive. A concurrent winner gets the
        // same admission as our own publication; existing modes are not changed.
        this.verify();
        try { fs.mkdirSync(candidate, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        stat = fs.lstatSync(candidate, { bigint: true });
      }
      validateDirectory(stat, privateAnchor);
      const canonical = fs.realpathSync(candidate);
      if (path.dirname(canonical) !== parent.canonical) throw new RuntimeDirectoryAdmissionError();
      this.directories.set(candidate, { stat, canonical, privateAnchor });
      this.verify();
    } catch {
      // Neither native path errors nor filesystem identities enter diagnostics.
      throw new RuntimeDirectoryAdmissionError();
    }
  }

  /** Directory child creation changes size/timestamps/nlink, not admitted identity. */
  verify(): void {
    try {
      for (const [directory, expected] of this.directories) {
        const current = fs.lstatSync(directory, { bigint: true });
        validateDirectory(current, expected.privateAnchor);
        for (const field of ['dev', 'ino', 'mode', 'uid', 'gid'] as const) {
          if (current[field] !== expected.stat[field]) throw new RuntimeDirectoryAdmissionError();
        }
        if (fs.realpathSync(directory) !== expected.canonical) throw new RuntimeDirectoryAdmissionError();
      }
    } catch {
      throw new RuntimeDirectoryAdmissionError();
    }
  }
}
