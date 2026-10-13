import { createHash } from 'node:crypto';
import type { McpSecurityReview } from '@/shared/mcpSecurityReview';

export const SOURCE_LIMITS = { files: 256, bytes: 8 * 1024 * 1024, fileBytes: 1024 * 1024 } as const;
export class UnsupportedReviewSource extends Error {}
export interface ReviewSource {
  source: NonNullable<McpSecurityReview['source']>;
  files: Array<{ path: string; content: Buffer }>;
}

export function canonicalGithubRepository(value: string): { repositoryUrl: string; apiPath: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new UnsupportedReviewSource('Use a public https://github.com/owner/repository URL.'); }
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,38})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!/^https:\/\/github\.com\/[^?#%\s]+$/i.test(value) || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !match || ['.', '..'].includes(match[2]) || value.split('/').some(part => part === '.' || part === '..')) {
    throw new UnsupportedReviewSource('Use a public https://github.com/owner/repository URL.');
  }
  const owner = match[1].toLowerCase(), repo = match[2].toLowerCase();
  return { repositoryUrl: `https://github.com/${owner}/${repo}`, apiPath: `/repos/${owner}/${repo}` };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UnsupportedReviewSource('GitHub source metadata is invalid.');
  return value as Record<string, unknown>;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) throw new UnsupportedReviewSource('GitHub did not provide an immutable source identity.');
  return value.toLowerCase();
}

/** No redirects, ambient credentials, git checkout, filters, hooks, or source execution. */
async function apiJson(apiPath: string, maximum: number, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch(`https://api.github.com${apiPath}`, {
    signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'FLUJO-optional-source-review' },
  });
  if (!response.ok || !response.body) throw new Error('Public GitHub source lookup is unavailable.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maximum) throw new UnsupportedReviewSource('GitHub source response exceeds review limits.');
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function validateReviewPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || value.normalize('NFC') !== value || value.split('/').some(part =>
    !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[\\\x00-\x1f\x7f:*?"<>|]/.test(part)
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new UnsupportedReviewSource('The repository contains an unsupported source path.');
  }
  if (Buffer.byteLength(value) > 100) {
    const split = value.lastIndexOf('/');
    if (split < 0 || Buffer.byteLength(value.slice(split + 1)) > 100 || Buffer.byteLength(value.slice(0, split)) > 155) {
      throw new UnsupportedReviewSource('A source path exceeds the supported archive byte limits.');
    }
  }
  return value;
}

export async function fetchGithubReviewSource(repositoryUrl: string, revision: string | undefined, signal: AbortSignal): Promise<ReviewSource> {
  const repository = canonicalGithubRepository(repositoryUrl);
  if (revision !== undefined && !/^[a-f0-9]{40}$/i.test(revision)) throw new UnsupportedReviewSource('The revision must be a complete Git commit SHA.');
  const commit = record(await apiJson(`${repository.apiPath}/commits/${revision ?? 'HEAD'}`, 256 * 1024, signal));
  const resolvedRevision = sha(commit.sha);
  if (revision && resolvedRevision !== revision.toLowerCase()) throw new UnsupportedReviewSource('GitHub returned a different revision.');
  const treeSha = sha(record(record(commit.commit).tree).sha);
  const tree = record(await apiJson(`${repository.apiPath}/git/trees/${treeSha}?recursive=1`, 2 * 1024 * 1024, signal));
  if (sha(tree.sha) !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) throw new UnsupportedReviewSource('A complete repository tree could not be reviewed.');
  const paths = new Map<string, string>();
  const blobs: Array<{ path: string; sha: string; size: number }> = [];
  let total = 0;
  for (const raw of tree.tree) {
    const entry = record(raw), filename = validateReviewPath(entry.path);
    const key = filename.toLowerCase();
    if (paths.has(key)) throw new UnsupportedReviewSource('The repository contains duplicate or case-colliding paths.');
    paths.set(key, filename);
    if (entry.type === 'tree' && entry.mode === '040000') continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(String(entry.mode))) throw new UnsupportedReviewSource('Links and submodules cannot be completely reviewed.');
    if (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0 || Number(entry.size) > SOURCE_LIMITS.fileBytes) throw new UnsupportedReviewSource('A source file exceeds review limits.');
    total += Number(entry.size);
    blobs.push({ path: filename, sha: sha(entry.sha), size: Number(entry.size) });
    if (blobs.length > SOURCE_LIMITS.files || total > SOURCE_LIMITS.bytes) throw new UnsupportedReviewSource('The complete repository exceeds review limits.');
  }
  if (!blobs.length) throw new UnsupportedReviewSource('The repository has no reviewable files.');
  // Reject file/directory aliases, including implicit ancestors in malformed metadata.
  for (const entry of blobs) {
    const segments = entry.path.split('/');
    for (let count = 1; count < segments.length; count++) {
      const ancestor = segments.slice(0, count).join('/');
      const declared = paths.get(ancestor.toLowerCase());
      if (declared !== ancestor || blobs.some(blob => blob.path.toLowerCase() === ancestor.toLowerCase())) throw new UnsupportedReviewSource('Source paths collide with directory names or lack a complete directory inventory.');
    }
  }
  const files: ReviewSource['files'] = [];
  for (const blob of blobs.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    const body = record(await apiJson(`${repository.apiPath}/git/blobs/${blob.sha}`, 2 * SOURCE_LIMITS.fileBytes, signal));
    if (sha(body.sha) !== blob.sha || body.encoding !== 'base64' || typeof body.content !== 'string' || body.size !== blob.size) throw new UnsupportedReviewSource('Source blob identity is invalid.');
    const encoded = body.content.replace(/\n/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new UnsupportedReviewSource('Source blob encoding is invalid.');
    const content = Buffer.from(encoded, 'base64');
    const gitDigest = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    if (content.length !== blob.size || gitDigest !== blob.sha) throw new UnsupportedReviewSource('Source bytes do not match the Git tree.');
    if (content.subarray(0, 200).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) throw new UnsupportedReviewSource('Git LFS pointers do not contain the source bytes.');
    files.push({ path: blob.path, content });
  }
  signal.throwIfAborted();
  const digest = createHash('sha256');
  for (const file of files) digest.update(JSON.stringify([file.path, file.content.length, createHash('sha256').update(file.content).digest('hex')]) + '\n');
  return { source: { repositoryUrl: repository.repositoryUrl, revision: resolvedRevision, digest: digest.digest('hex'), fileCount: files.length, bytes: total }, files };
}
