import { PersonaRecoveryError } from './personaRecoveryError';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { getPersonaFilesystemClock } from './runtimeClock';
import { PERSONA_RECOVERY_ZIP_LIMITS } from './personaRecoveryZip';

type Fingerprint = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs' | 'nlink'>;
const same = (a: Fingerprint, b: Fingerprint) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const clock = getPersonaFilesystemClock();

/**
 * Strict, read-only input collector. Registered writers are stopped by the
 * caller's capture boundary. These checks additionally reject links and changes
 * observed during capture; they do not claim to lock arbitrary external writers.
 */
export class PersonaRecoveryFileReader {
  private readonly files = new Map<string, { stats: Stats; bytes: Buffer }>();
  private readonly directories = new Map<string, { stats: Stats; names?: string[] }>();
  private readonly absent = new Set<string>();
  private bytes = 0;
  private readonly deadline: number;
  readonly root: string;

  constructor(root: string, private readonly options: {
    signal?: AbortSignal; timeoutMs?: number; fileBytes?: number; totalBytes?: number; entries?: number;
  } = {}) {
    this.root = path.resolve(root);
    for (const [key, value, maximum] of [
      ['timeoutMs', options.timeoutMs ?? 30_000, 120_000],
      ['fileBytes', options.fileBytes ?? PERSONA_RECOVERY_ZIP_LIMITS.fileBytes, PERSONA_RECOVERY_ZIP_LIMITS.fileBytes],
      ['totalBytes', options.totalBytes ?? PERSONA_RECOVERY_ZIP_LIMITS.totalBytes, PERSONA_RECOVERY_ZIP_LIMITS.totalBytes],
      ['entries', options.entries ?? PERSONA_RECOVERY_ZIP_LIMITS.members, PERSONA_RECOVERY_ZIP_LIMITS.members],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new PersonaRecoveryError(`Invalid recovery ${key} limit.`);
    }
    this.deadline = clock.monotonicNow() + (options.timeoutMs ?? 30_000);
  }

  private check(): void {
    this.options.signal?.throwIfAborted();
    if (clock.monotonicNow() > this.deadline) throw new PersonaRecoveryError('Persona recovery capture timed out; retry while the workspace is idle.');
    if (this.files.size + this.directories.size + this.absent.size > (this.options.entries ?? PERSONA_RECOVERY_ZIP_LIMITS.members)) {
      throw new PersonaRecoveryError('Persona recovery capture exceeds the entry limit.');
    }
  }

  private resolve(relative: string): string {
    if (!relative || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..'
      || /[\u0000-\u001f:<>"|?*]/.test(part))) throw new PersonaRecoveryError('Unsafe Persona recovery source path.');
    const result = path.resolve(this.root, ...relative.split('/'));
    if (!result.startsWith(`${this.root}${path.sep}`)) throw new PersonaRecoveryError('Recovery source escaped its workspace.');
    return result;
  }

  private async statOptional(target: string): Promise<Stats | undefined> {
    try { return await fs.lstat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.absent.add(target); return undefined; }
      throw error;
    }
  }

  private async directory(target: string): Promise<boolean> {
    this.check();
    const relative = path.relative(this.root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new PersonaRecoveryError('Recovery directory escaped its workspace.');
    let current = this.root;
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const stats = await this.statOptional(current);
      if (!stats) return false;
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new PersonaRecoveryError('Recovery input contains a linked or non-directory path.');
      const prior = this.directories.get(current);
      if (prior && (prior.stats.dev !== stats.dev || prior.stats.ino !== stats.ino)) {
        throw new PersonaRecoveryError('Recovery directory changed during capture.');
      }
      if (!prior) this.directories.set(current, { stats });
    }
    const canonicalRoot = await fs.realpath(this.root);
    const canonical = await fs.realpath(target);
    const canonicalRelative = path.relative(canonicalRoot, canonical);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) throw new PersonaRecoveryError('Recovery directory resolves outside its workspace.');
    return true;
  }

  async read(relative: string, required = false): Promise<Buffer | undefined> {
    this.check();
    const target = this.resolve(relative);
    const cached = this.files.get(target);
    if (cached) return cached.bytes;
    const parentExists = await this.directory(path.dirname(target));
    const stats = parentExists ? await this.statOptional(target) : undefined;
    if (!stats) {
      if (required) throw new PersonaRecoveryError(`Persona recovery is missing ${relative}.`);
      return undefined;
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) throw new PersonaRecoveryError(`Recovery input is not an unlinked regular file: ${relative}`);
    const fileLimit = this.options.fileBytes ?? (relative === 'db/persona-recovery/source.zip'
      ? PERSONA_RECOVERY_ZIP_LIMITS.archiveBytes : PERSONA_RECOVERY_ZIP_LIMITS.fileBytes);
    if (stats.size > fileLimit
      || this.bytes + stats.size > (this.options.totalBytes ?? PERSONA_RECOVERY_ZIP_LIMITS.totalBytes)) {
      throw new PersonaRecoveryError('Persona recovery capture exceeds the byte limit.');
    }
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !same(stats, opened)) throw new PersonaRecoveryError('Recovery file changed before it could be read.');
      const bytes = Buffer.alloc(stats.size);
      let offset = 0;
      while (offset < bytes.length) {
        this.check();
        const { bytesRead } = await handle.read(bytes, offset, Math.min(bytes.length - offset, 1024 * 1024), offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== bytes.length || !same(opened, await handle.stat()) || !same(opened, await fs.lstat(target))) {
        throw new PersonaRecoveryError('Recovery file changed while being read.');
      }
      this.bytes += bytes.length;
      this.files.set(target, { stats: opened, bytes });
      this.check();
      return bytes;
    } finally { await handle.close(); }
  }

  /** Return files only, while remembering even empty directory inventories. */
  async scan(relative: string): Promise<string[]> {
    const target = this.resolve(relative);
    if (!await this.directory(target)) return [];
    const result: string[] = [];
    const pending = [{ target, relative, depth: 0 }];
    while (pending.length) {
      this.check();
      const current = pending.pop()!;
      if (current.depth > 32) throw new PersonaRecoveryError('Recovery directory nesting exceeds the limit.');
      if (!await this.directory(current.target)) throw new PersonaRecoveryError('Recovery directory disappeared during capture.');
      const names = (await fs.readdir(current.target)).sort();
      const state = this.directories.get(current.target)!;
      if (state.names && JSON.stringify(state.names) !== JSON.stringify(names)) throw new PersonaRecoveryError('Recovery directory changed during capture.');
      state.names = names;
      for (const name of names) {
        const childRelative = `${current.relative}/${name}`;
        const child = this.resolve(childRelative);
        const stats = await fs.lstat(child);
        if (stats.isSymbolicLink()) throw new PersonaRecoveryError('Recovery input contains a symbolic link or junction.');
        if (stats.isDirectory()) pending.push({ target: child, relative: childRelative, depth: current.depth + 1 });
        else if (stats.isFile() && stats.nlink === 1) result.push(childRelative);
        else throw new PersonaRecoveryError('Recovery input contains a hard link or non-regular file.');
        if (result.length + pending.length > (this.options.entries ?? PERSONA_RECOVERY_ZIP_LIMITS.members)) {
          throw new PersonaRecoveryError('Persona recovery capture exceeds the entry limit.');
        }
      }
    }
    return result.sort();
  }

  async verifyUnchanged(): Promise<void> {
    for (const [target, original] of this.files) {
      this.check();
      const current = await fs.lstat(target);
      if (!current.isFile() || current.isSymbolicLink() || !same(original.stats, current)) throw new PersonaRecoveryError('Recovery file changed during capture.');
    }
    for (const [target, original] of this.directories) {
      this.check();
      const current = await fs.lstat(target);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.stats.dev || current.ino !== original.stats.ino) {
        throw new PersonaRecoveryError('Recovery directory changed during capture.');
      }
      if (original.names && JSON.stringify((await fs.readdir(target)).sort()) !== JSON.stringify(original.names)) {
        throw new PersonaRecoveryError('Recovery directory inventory changed during capture.');
      }
    }
    for (const target of this.absent) {
      this.check();
      if (await this.statOptional(target)) throw new PersonaRecoveryError('Recovery input appeared during capture.');
    }
  }
}
