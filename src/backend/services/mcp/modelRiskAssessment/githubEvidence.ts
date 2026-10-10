import { createHash } from 'node:crypto';
import type { McpModelRiskEvidence } from '@/shared/mcpModelRiskAssessment';
import { canonicalGithubRepository, validateReviewPath } from '../securityReview/githubSource';

const MAX_FILE = 128 * 1024, MAX_EXCERPT = 16 * 1024, MAX_TOTAL = 48 * 1024, MAX_FILES = 6;
class EvidenceLimitError extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub evidence.');
  return value as Record<string, unknown>;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) throw new Error('Invalid GitHub revision.');
  return value.toLowerCase();
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function date(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds > Date.now() || new Date(milliseconds).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return new Date(milliseconds).toISOString();
}

/** Public fixed-origin API reads only. The caller owns the hard source deadline. */
async function api(apiPath: string, maximum: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const response = await fetch(`https://api.github.com${apiPath}`, {
    signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'FLUJO-on-demand-risk-evidence' },
  });
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); throw new Error('Public GitHub evidence is unavailable.'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maximum) throw new EvidenceLimitError('GitHub evidence exceeds the read limit.');
      chunks.push(chunk.value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function optionalApi(path: string, maximum: number, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  try { return await api(path, maximum, signal); }
  catch { signal.throwIfAborted(); return null; }
}

async function sourceSample(apiPath: string, commit: Record<string, unknown>, signal: AbortSignal,
  addLimitation: (value: McpModelRiskEvidence['limitations'][number]) => void): Promise<McpModelRiskEvidence['files']> {
  addLimitation('sampleOnly');
  const files: McpModelRiskEvidence['files'] = [];
  try {
    const treeSha = hash(object(object(commit.commit).tree).sha);
    const tree = await api(`${apiPath}/git/trees/${treeSha}?recursive=1`, 1024 * 1024, signal);
    if (hash(tree.sha) !== treeSha || !Array.isArray(tree.tree) || tree.tree.length > 8192) throw new Error('Invalid source inventory.');
    if (tree.truncated !== false) { addLimitation('sourceTruncated'); throw new Error('Incomplete source inventory.'); }
    const paths = new Map<string, string>(), entries = new Map<string, { sha: string; size: number }>();
    const directories = new Set<string>();
    for (const value of tree.tree) {
      const entry = object(value), filename = validateReviewPath(entry.path), key = filename.toLowerCase();
      if (paths.has(key)) throw new Error('Case-colliding source paths.');
      paths.set(key, filename);
      if (entry.type === 'tree' && entry.mode === '040000') { directories.add(filename); continue; }
      if (entry.type !== 'blob' || !['100644', '100755'].includes(String(entry.mode)) || count(entry.size) === null) throw new Error('Unsupported source entry.');
      entries.set(filename, { sha: hash(entry.sha), size: Number(entry.size) });
    }
    for (const filename of entries.keys()) {
      const segments = filename.split('/');
      for (let index = 1; index < segments.length; index++) {
        if (!directories.has(segments.slice(0, index).join('/'))) throw new Error('Incomplete or colliding directory inventory.');
      }
    }
    const candidates: string[] = [];
    const append = (filename: string) => { if (entries.has(filename) && !candidates.includes(filename)) candidates.push(filename); };
    const readme = [...entries.keys()].filter(filename => /^readme(?:\.(?:md|rst|txt))?$/i.test(filename)).sort()[0];
    if (readme) append(readme);
    append('package.json'); append('pyproject.toml');
    const appendCommon = () => { for (const common of ['src/index.ts', 'src/index.js', 'index.js', 'index.ts', 'server.py', 'main.py', 'server.js', 'main.js']) append(common); };
    if (!candidates.length) appendCommon();
    let total = 0, requests = 0;
    for (let index = 0; index < candidates.length && requests < MAX_FILES; index++) {
      signal.throwIfAborted();
      const filename = candidates[index], entry = entries.get(filename)!;
      if (total >= MAX_TOTAL) { addLimitation('sourceTruncated'); break; }
      if (entry.size > MAX_FILE) { addLimitation('sourceTruncated'); addLimitation('sourceUnavailable'); if (index === candidates.length - 1) appendCommon(); continue; }
      requests++;
      try {
        const blob = await api(`${apiPath}/git/blobs/${entry.sha}`, 256 * 1024, signal);
        if (hash(blob.sha) !== entry.sha || blob.encoding !== 'base64' || blob.size !== entry.size || typeof blob.content !== 'string') throw new Error('Source identity mismatch.');
        const encoded = blob.content.replace(/\n/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid blob encoding.');
        const content = Buffer.from(encoded, 'base64');
        if (content.length !== entry.size || createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex') !== entry.sha) throw new Error('Source byte mismatch.');
        const fullText = new TextDecoder('utf-8', { fatal: true }).decode(content);
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(fullText) || fullText.startsWith('version https://git-lfs.github.com/spec/v1')) throw new Error('Unsupported source bytes.');
        let length = Math.min(content.length, MAX_EXCERPT, MAX_TOTAL - total);
        while (length < content.length && length > 0 && (content[length] & 0xc0) === 0x80) length--;
        const excerpt = content.subarray(0, length), truncated = length < content.length;
        if (truncated) addLimitation('sourceTruncated');
        files.push({ path: filename, blobSha: entry.sha, excerptDigest: createHash('sha256').update(excerpt).digest('hex'), bytes: excerpt.length,
          text: new TextDecoder('utf-8', { fatal: true }).decode(excerpt), truncated });
        total += excerpt.length;
        if (filename === 'package.json') {
          try {
            const manifest = object(JSON.parse(fullText));
            const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin && typeof manifest.bin === 'object' ? Object.values(object(manifest.bin)).find(value => typeof value === 'string') : undefined;
            for (const declared of [manifest.main, bin]) if (typeof declared === 'string') {
              const path = declared.replace(/^\.\//, '');
              append(validateReviewPath(path));
            }
          } catch { addLimitation('sourceUnavailable'); }
        }
      } catch (error) {
        signal.throwIfAborted();
        addLimitation('sourceUnavailable');
        if (error instanceof EvidenceLimitError) addLimitation('sourceTruncated');
      }
      // Append common entries after reading root manifests so declared entries win.
      if (index === candidates.length - 1) appendCommon();
    }
    if (!candidates.length) {
      // No README/manifest: common entries still provide an explicitly limited sample.
      addLimitation('sourceUnavailable');
    }
    if (requests >= MAX_FILES && candidates.length > requests) addLimitation('sourceTruncated');
    if (!files.length) addLimitation('sourceUnavailable');
  } catch (error) {
    signal.throwIfAborted();
    addLimitation('sourceUnavailable');
    if (error instanceof EvidenceLimitError) addLimitation('sourceTruncated');
  }
  return files;
}

export async function fetchGithubRiskEvidence(repositoryUrl: string, includeSource: boolean, signal: AbortSignal): Promise<McpModelRiskEvidence> {
  const target = canonicalGithubRepository(repositoryUrl);
  signal.throwIfAborted();
  const repository = await api(target.apiPath, 128 * 1024, signal);
  const identity = target.apiPath.slice('/repos/'.length), [ownerLogin] = identity.split('/');
  const owner = object(repository.owner);
  if (typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== identity || repository.private !== false
    || typeof owner.login !== 'string' || owner.login.toLowerCase() !== ownerLogin || !['User', 'Organization'].includes(String(owner.type))) throw new Error('Repository identity could not be validated.');
  const commit = await api(`${target.apiPath}/commits/HEAD`, 256 * 1024, signal);
  const revision = hash(commit.sha), commitDetails = object(commit.commit);
  const capturedAt = new Date().toISOString();
  const limitations = new Set<McpModelRiskEvidence['limitations'][number]>();
  const add = (value: McpModelRiskEvidence['limitations'][number]) => { limitations.add(value); };
  const stars = count(repository.stargazers_count), forks = count(repository.forks_count);
  const lastCommitAt = commitDetails.committer && typeof commitDetails.committer === 'object' && !Array.isArray(commitDetails.committer) ? date(object(commitDetails.committer).date) : null;
  if (stars === null || forks === null || lastCommitAt === null) add('repositorySignalsUnavailable');
  const optionalResults = await Promise.allSettled([
    optionalApi(`/users/${ownerLogin}`, 128 * 1024, signal),
    optionalApi(`/search/issues?q=${encodeURIComponent(`repo:${identity} is:issue is:open`)}&per_page=1`, 64 * 1024, signal),
    optionalApi(`/search/issues?q=${encodeURIComponent(`repo:${identity} is:issue is:closed`)}&per_page=1`, 64 * 1024, signal),
  ]);
  signal.throwIfAborted();
  const [profile, openSearch, closedSearch] = optionalResults.map(result => result.status === 'fulfilled' ? result.value : null);
  let followers: number | null = null, publicRepositories: number | null = null, createdAt: string | null = null;
  if (profile && typeof profile.login === 'string' && profile.login.toLowerCase() === ownerLogin && profile.type === owner.type) {
    followers = count(profile.followers); publicRepositories = count(profile.public_repos); createdAt = date(profile.created_at);
  }
  if (followers === null || publicRepositories === null || createdAt === null) add('authorUnavailable');
  const issueCount = (search: Record<string, unknown> | null) => search?.incomplete_results === false ? count(search.total_count) : null;
  const openIssues = issueCount(openSearch), closedIssues = issueCount(closedSearch);
  if (openIssues === null || closedIssues === null) add('issuesUnavailable');
  const issueTotal = openIssues !== null && closedIssues !== null ? openIssues + closedIssues : null;
  if (issueTotal !== null && !Number.isSafeInteger(issueTotal)) add('issuesUnavailable');
  const openIssueRatio = issueTotal && Number.isSafeInteger(issueTotal) && openIssues !== null ? openIssues / issueTotal : null;
  const files = includeSource ? await sourceSample(target.apiPath, commit, signal, add) : [];
  if (!includeSource) add('signalsOnly');
  signal.throwIfAborted();
  const evidence = { repositoryUrl: target.repositoryUrl, revision, capturedAt,
    repository: { stars, forks, lastCommitAt, openIssues, closedIssues, openIssueRatio },
    author: { login: ownerLogin, type: owner.type as 'User' | 'Organization', followers, publicRepositories, createdAt,
      accountAgeDays: createdAt ? Math.floor((Date.parse(capturedAt) - Date.parse(createdAt)) / 86_400_000) : null },
    files, limitations: [...limitations].sort() };
  return { ...evidence, evidenceDigest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') };
}
