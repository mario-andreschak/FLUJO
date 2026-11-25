import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { realpath } from '../../../utils/realpath';

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
  private readonly directories = new Map<string, AdmittedDirectory>();

  private constructor(private readonly root: string) {}

  /** Admit an existing workspace root; never create it. */
  static async open(workspaceRoot: string): Promise<RuntimeDirectoryAdmission> {
    try {
      const admission = new RuntimeDirectoryAdmission(path.resolve(workspaceRoot));
      const stat = await fs.lstat(admission.root, { bigint: true });
      validateDirectory(stat, false);
      admission.directories.set(admission.root, { stat, canonical: await realpath(admission.root), privateAnchor: false });
      await admission.verify();
      return admission;
    } catch {
      throw new RuntimeDirectoryAdmissionError();
    }
  }

  /** Create only a direct child of an admitted parent; never recreate the workspace. */
  async admit(directory: string, privateAnchor = false): Promise<void> {
    try {
      await this.verify();
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
        stat = await fs.lstat(candidate, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!stat) {
        // mkdir without recursive is exclusive. A concurrent winner gets the
        // same admission as our own publication; existing modes are not changed.
        await this.verify();
        try { await fs.mkdir(candidate, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        stat = await fs.lstat(candidate, { bigint: true });
      }
      validateDirectory(stat, privateAnchor);
      const canonical = await realpath(candidate);
      if (path.dirname(canonical) !== parent.canonical) throw new RuntimeDirectoryAdmissionError();
      this.directories.set(candidate, { stat, canonical, privateAnchor });
      await this.verify();
    } catch {
      // Neither native path errors nor filesystem identities enter diagnostics.
      throw new RuntimeDirectoryAdmissionError();
    }
  }

  /** Directory child creation changes size/timestamps/nlink, not admitted identity. */
  async verify(): Promise<void> {
    try {
      await Promise.all([...this.directories].map(async ([directory, expected]) => {
        const [current, canonical] = await Promise.all([
          fs.lstat(directory, { bigint: true }),
          realpath(directory),
        ]);
        validateDirectory(current, expected.privateAnchor);
        for (const field of ['dev', 'ino', 'mode', 'uid', 'gid'] as const) {
          if (current[field] !== expected.stat[field]) throw new RuntimeDirectoryAdmissionError();
        }
        if (canonical !== expected.canonical) throw new RuntimeDirectoryAdmissionError();
      }));
    } catch {
      throw new RuntimeDirectoryAdmissionError();
    }
  }
}
