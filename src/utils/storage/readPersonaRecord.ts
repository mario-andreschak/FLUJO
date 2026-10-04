import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { PlainFileReadError, readPlainFile } from '../readPlainFile';

type Parent = { filename: string; stats: BigIntStats; canonical: string };
export type PersonaRecordText = { content: string; mtimeMs: number; sizeBytes: number };
const MAX_ATTEMPTS = 3;

function contained(root: string, filename: string) {
  const relative = path.relative(root, filename);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Persona record path escapes its storage root.');
  }
  return relative;
}
function regular(stats: BigIntStats) {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === BigInt(1);
}
function replacement(previous: BigIntStats, fresh: BigIntStats) {
  return regular(previous) && regular(fresh) && previous.ino !== fresh.ino
    && previous.dev === fresh.dev && previous.uid === fresh.uid && previous.gid === fresh.gid
    && previous.mode === fresh.mode;
}
async function statOrNull(filename: string) {
  try { return await fs.lstat(filename, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function parentsFor(root: string, filename: string): Promise<Parent[] | null> {
  const directories = [root];
  const relative = contained(root, filename);
  const segments = relative.split(path.sep).slice(0, -1);
  for (const segment of segments) directories.push(path.join(directories[directories.length - 1], segment));
  const parents: Parent[] = [];
  for (const directory of directories) {
    const stats = await statOrNull(directory);
    if (!stats) return null;
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Persona record parent is not a link-free directory.');
    const canonical = await fs.realpath(directory);
    if (parents.length) contained(parents[0].canonical, canonical);
    parents.push({ filename: directory, stats, canonical });
  }
  return parents;
}
async function verifyParents(parents: Parent[]) {
  for (const parent of parents) {
    const current = await fs.lstat(parent.filename, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== parent.stats.dev
        || current.ino !== parent.stats.ino || current.mode !== parent.stats.mode
        || current.uid !== parent.stats.uid || current.gid !== parent.stats.gid
        || await fs.realpath(parent.filename) !== parent.canonical) {
      throw new Error('Persona record parent changed during its read.');
    }
  }
}

/**
 * Point reads may overlap a legitimate atomic Persona record publication.
 * Retry only a different, fully revalidated inode in the same admitted parents;
 * the strict descriptor reader's unsafe/snapshot checks remain unchanged.
 */
export async function readPersonaRecordText(filename: string, storageRoot: string): Promise<PersonaRecordText | null> {
  const root = path.resolve(storageRoot);
  const file = path.resolve(filename);
  contained(root, file);
  const parents = await parentsFor(root, file);
  if (!parents) return null;
  let expected = await statOrNull(file);
  if (!expected) return null;
  if (!regular(expected)) throw new PlainFileReadError('UNSAFE_FILE');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await verifyParents(parents);
    try {
      const content = (await readPlainFile(file, { expected, verifyPath: () => verifyParents(parents) })).toString('utf8');
      return { content, mtimeMs: Number(expected.mtimeNs) / 1_000_000, sizeBytes: Number(expected.size) };
    } catch (error) {
      if (!(error instanceof PlainFileReadError) || error.code === 'SIZE_LIMIT' || attempt + 1 === MAX_ATTEMPTS) throw error;
      await verifyParents(parents);
      const fresh = await statOrNull(file);
      // In-place edits, deletion, links, owner/mode/device changes and unknown
      // identities are not an atomic-publication availability retry.
      if (!fresh || !replacement(expected, fresh)) throw error;
      expected = fresh;
    }
  }
  throw new PlainFileReadError('FILE_CHANGED');
}
