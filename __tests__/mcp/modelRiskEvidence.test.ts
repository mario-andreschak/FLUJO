import { createHash } from 'node:crypto';
import { fetchGithubRiskEvidence } from '@/backend/services/mcp/modelRiskAssessment/githubEvidence';

const revision = 'a'.repeat(40), treeSha = 'b'.repeat(40);
const repository = () => ({ full_name: 'owner/repo', private: false, owner: { login: 'Owner', type: 'User' }, stargazers_count: 12, forks_count: 3, open_issues_count: 999 });
const commit = () => ({ sha: revision, commit: { tree: { sha: treeSha }, committer: { date: '2025-04-03T12:13:14Z' } } });
const profile = () => ({ login: 'owner', type: 'User', followers: 4, public_repos: 9, created_at: '2020-01-01T00:00:00Z' });
const originalFetch = global.fetch;
let fetchMock: jest.Mock;
let responses: Map<string, unknown | Response>;
let sourceFiles: Array<{ path: string; content: Buffer; mode?: string }>;
const signal = () => new AbortController().signal;
const blobSha = (content: Buffer) => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
function materializeSource() {
  const directories = [...new Set(sourceFiles.flatMap(file => file.path.split('/').slice(0, -1).map((_segment, index) => file.path.split('/').slice(0, index + 1).join('/'))))];
  responses.set(`/repos/owner/repo/git/trees/${treeSha}`, { sha: treeSha, truncated: false, tree: [
    ...directories.map(path => ({ path, type: 'tree', mode: '040000', sha: treeSha })),
    ...sourceFiles.map(file => ({ path: file.path, type: 'blob', mode: file.mode ?? '100644', sha: blobSha(file.content), size: file.content.length })),
  ] });
  for (const file of sourceFiles) responses.set(`/repos/owner/repo/git/blobs/${blobSha(file.content)}`, { sha: blobSha(file.content), size: file.content.length, encoding: 'base64', content: file.content.toString('base64') });
}
beforeEach(() => {
  responses = new Map<string, unknown | Response>([
    ['/repos/owner/repo', repository()], ['/repos/owner/repo/commits/HEAD', commit()], ['/users/owner', profile()],
    ['open', { total_count: 2, incomplete_results: false, items: [] }], ['closed', { total_count: 8, incomplete_results: false, items: [] }],
  ]);
  sourceFiles = [{ path: 'README.md', content: Buffer.from('Documentation') }, { path: 'package.json', content: Buffer.from('{"main":"src/server.js"}') }, { path: 'src/server.js', content: Buffer.from('console.log("untrusted");') }];
  materializeSource();
  fetchMock = jest.fn(async (url: string) => {
    const parsed = new URL(url), query = parsed.searchParams.get('q') ?? '';
    const body = responses.get(parsed.pathname === '/search/issues' ? query.includes('is:open') ? 'open' : 'closed' : parsed.pathname);
    return body instanceof Response ? body : body === undefined ? new Response('', { status: 404 }) : Response.json(body);
  });
  global.fetch = fetchMock;
});
afterAll(() => { global.fetch = originalFetch; });

it('captures public identity, commit date and exact issue-only counts without ambient authentication', async () => {
  const evidence = await fetchGithubRiskEvidence('https://github.com/Owner/Repo.git/', false, signal());
  expect(evidence.repositoryUrl).toBe('https://github.com/owner/repo');
  expect(evidence.revision).toBe(revision);
  expect(evidence.repository).toEqual({ stars: 12, forks: 3, lastCommitAt: '2025-04-03T12:13:14.000Z', openIssues: 2, closedIssues: 8, openIssueRatio: .2 });
  expect(evidence.author).toMatchObject({ login: 'owner', type: 'User', followers: 4, publicRepositories: 9, createdAt: '2020-01-01T00:00:00.000Z', accountAgeDays: expect.any(Number) });
  const queries = fetchMock.mock.calls.map(([url]) => new URL(url)).filter(url => url.pathname === '/search/issues');
  expect(queries.map(url => url.searchParams.get('q'))).toEqual(['repo:owner/repo is:issue is:open', 'repo:owner/repo is:issue is:closed']);
  expect(fetchMock.mock.calls.filter(([url]) => url.includes('/commits/HEAD'))).toHaveLength(1);
  for (const [url, options] of fetchMock.mock.calls) {
    expect(new URL(url).hostname).toBe('api.github.com');
    expect(options).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(Object.keys(options.headers).sort()).toEqual(['accept', 'user-agent']);
  }
  const { evidenceDigest, ...captured } = evidence;
  expect(evidenceDigest).toBe(createHash('sha256').update(JSON.stringify(captured)).digest('hex'));
});
it('does not fetch tree or source bytes without opt-in', async () => {
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', false, signal());
  expect(evidence.files).toEqual([]); expect(evidence.limitations).toEqual(['signalsOnly']);
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/git/'))).toBe(false);
});
it.each([
  { ...repository(), full_name: 'other/repo' }, { ...repository(), private: true }, { ...repository(), owner: { login: 'foreign', type: 'User' } },
])('refuses identity drift %j', async value => {
  responses.set('/repos/owner/repo', value);
  await expect(fetchGithubRiskEvidence('https://github.com/owner/repo', false, signal())).rejects.toThrow(/identity/);
});
it('refuses a missing repository identity instead of guessing it from the URL', async () => {
  responses.set('/repos/owner/repo', new Response('', { status: 403 }));
  await expect(fetchGithubRiskEvidence('https://github.com/owner/repo', false, signal())).rejects.toThrow();
});
it('requires an immutable commit hash', async () => {
  responses.set('/repos/owner/repo/commits/HEAD', { ...commit(), sha: 'main' });
  await expect(fetchGithubRiskEvidence('https://github.com/owner/repo', false, signal())).rejects.toThrow(/revision/);
});
it.each([new Response('', { status: 429 }), { total_count: 2, incomplete_results: true }, { total_count: -1, incomplete_results: false }])('keeps unavailable/partial issue counts nullable', async result => {
  responses.set('open', result);
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', false, signal());
  expect(evidence.repository.openIssues).toBeNull(); expect(evidence.repository.openIssueRatio).toBeNull();
  expect(evidence.limitations).toContain('issuesUnavailable');
});
it('does not invent a ratio when the repository has no issues', async () => {
  responses.set('open', { total_count: 0, incomplete_results: false }); responses.set('closed', { total_count: 0, incomplete_results: false });
  expect((await fetchGithubRiskEvidence('https://github.com/owner/repo', false, signal())).repository.openIssueRatio).toBeNull();
});
it('keeps missing author and repository statistics nullable without following supplied metadata URLs', async () => {
  responses.set('/repos/owner/repo', { ...repository(), stargazers_count: undefined, forks_count: 'many', html_url: 'https://evil.test/' });
  responses.set('/users/owner', new Response('', { status: 404 }));
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', false, signal());
  expect(evidence.repository.stars).toBeNull(); expect(evidence.repository.forks).toBeNull();
  expect(evidence.author.followers).toBeNull(); expect(evidence.author.accountAgeDays).toBeNull();
  expect(evidence.limitations).toEqual(expect.arrayContaining(['authorUnavailable', 'repositorySignalsUnavailable']));
});
it('samples manifests and their declared entry from the pinned tree with verified blob digests', async () => {
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', true, signal());
  expect(evidence.files.map(file => file.path)).toEqual(['README.md', 'package.json', 'src/server.js']);
  expect(evidence.limitations).toEqual(['sampleOnly']);
  for (const file of evidence.files) {
    expect(file.blobSha).toBe(blobSha(Buffer.from(file.text)));
    expect(file.excerptDigest).toBe(createHash('sha256').update(file.text).digest('hex'));
  }
});
it.each(['../secret', '/absolute', 'a\\b', '.git/config'])('omits an unsafe inventory %s explicitly', async path => {
  sourceFiles[0].path = path; materializeSource();
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', true, signal());
  expect(evidence.files).toEqual([]); expect(evidence.limitations).toContain('sourceUnavailable');
});
it.each(['120000', '160000'])('refuses link/gitlink mode%s explicitly', async mode => {
  sourceFiles[0].mode = mode; materializeSource();
  expect((await fetchGithubRiskEvidence('https://github.com/owner/repo', true, signal())).limitations).toContain('sourceUnavailable');
});
it('rejects a case alias inventory before fetching blobs', async () => {
  sourceFiles.push({ path: 'readme.md', content: Buffer.from('different') }); materializeSource();
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', true, signal());
  expect(evidence.files).toHaveLength(0); expect(evidence.limitations).toContain('sourceUnavailable');
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/git/blobs/'))).toBe(false);
});
it('does not include source bytes with a wrong Git hash', async () => {
  const key = `/repos/owner/repo/git/blobs/${blobSha(sourceFiles[0].content)}`;
  const original = responses.get(key) as Record<string, unknown>;
  responses.set(key, { ...original, content: Buffer.from('Tampered!!!!!').toString('base64') });
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', true, signal());
  expect(evidence.files.some(file => file.path === 'README.md')).toBe(false); expect(evidence.limitations).toContain('sourceUnavailable');
});
it.each([Buffer.from([0xff, 0xfe]), Buffer.from('binary\0source'), Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:x')])('omits unsupported bytes explicitly', async content => {
  sourceFiles[0].content = content; materializeSource();
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', true, signal());
  expect(evidence.files.some(file => file.path === 'README.md')).toBe(false); expect(evidence.limitations).toContain('sourceUnavailable');
});
it('validates full bytes before taking UTF-8 safe excerpts and enforces the aggregate cap', async () => {
  sourceFiles = ['README.md', 'pyproject.toml', 'index.js', 'server.js'].map(path => ({ path, content: Buffer.from('é'.repeat(20_000)) })); materializeSource();
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', true, signal());
  expect(evidence.files).toHaveLength(3);
  expect(evidence.files.reduce((sum, file) => sum + file.bytes, 0)).toBe(48 * 1024);
  expect(evidence.files.every(file => file.bytes <= 16 * 1024 && file.truncated && !file.text.includes('\ufffd'))).toBe(true);
  expect(evidence.limitations).toContain('sourceTruncated');
});
it('omits oversized full source instead of hashing an unverified prefix', async () => {
  sourceFiles[0].content = Buffer.alloc(128 * 1024 + 1, 'a'); materializeSource();
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', true, signal());
  expect(evidence.files.some(file => file.path === 'README.md')).toBe(false);
  expect(evidence.limitations).toEqual(expect.arrayContaining(['sourceUnavailable', 'sourceTruncated']));
});
it('limits downloads to six sampled files even when many common entries exist', async () => {
  sourceFiles = ['README.md', 'package.json', 'pyproject.toml', 'index.js', 'index.ts', 'server.py', 'main.py', 'server.js', 'main.js'].map(path => ({ path, content: Buffer.from(path === 'package.json' ? '{}' : 'sample') }));
  materializeSource();
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', true, signal());
  expect(evidence.files).toHaveLength(6);
  expect(fetchMock.mock.calls.filter(([url]) => url.includes('/git/blobs/'))).toHaveLength(6);
  expect(evidence.limitations).toContain('sourceTruncated');
});
it('bounds real chunked repository response bytes and closes the reader', async () => {
  const cancel = jest.fn();
  responses.set('/repos/owner/repo', new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(128 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel })));
  await expect(fetchGithubRiskEvidence('https://github.com/owner/repo', false, signal())).rejects.toThrow(/limit/);
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('marks a bounded/truncated tree unavailable rather than claiming full source', async () => {
  responses.set(`/repos/owner/repo/git/trees/${treeSha}`, { sha: treeSha, tree: [], truncated: true });
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', true, signal());
  expect(evidence.files).toEqual([]); expect(evidence.limitations).toEqual(expect.arrayContaining(['sourceTruncated', 'sourceUnavailable']));
});
it.each(['tree', 'blob'])('bounds streamed optional %s response bytes and retains explicit limitations', async stage => {
  const cancel = jest.fn();
  const maximum = stage === 'tree' ? 1024 * 1024 : 256 * 1024;
  const key = stage === 'tree' ? `/repos/owner/repo/git/trees/${treeSha}` : `/repos/owner/repo/git/blobs/${blobSha(sourceFiles[0].content)}`;
  responses.set(key, new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(maximum)); controller.enqueue(new Uint8Array(1)); }, cancel })));
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', true, signal());
  expect(evidence.limitations).toEqual(expect.arrayContaining(['sourceTruncated', 'sourceUnavailable']));
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('keeps invalid and missing commit/author dates nullable instead of inventing dates', async () => {
  responses.set('/repos/owner/repo/commits/HEAD', { ...commit(), commit: { ...commit().commit, committer: { date: '2025-02-30T00:00:00Z' } } });
  responses.set('/users/owner', { ...profile(), created_at: '2099-01-01T00:00:00Z' });
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', false, signal());
  expect(evidence.repository.lastCommitAt).toBeNull(); expect(evidence.author.createdAt).toBeNull(); expect(evidence.author.accountAgeDays).toBeNull();
  expect(evidence.limitations).toEqual(expect.arrayContaining(['repositorySignalsUnavailable', 'authorUnavailable']));
});
it('retains organization identity without converting missing followers to zero', async () => {
  responses.set('/repos/owner/repo', { ...repository(), owner: { login: 'owner', type: 'Organization' } });
  responses.set('/users/owner', { ...profile(), type: 'Organization', followers: undefined });
  const evidence = await fetchGithubRiskEvidence('https://github.com/owner/repo', false, signal());
  expect(evidence.author.type).toBe('Organization'); expect(evidence.author.followers).toBeNull(); expect(evidence.limitations).toContain('authorUnavailable');
});
it('cancels a hanging source body and never turns cancellation into partial evidence', async () => {
  const controller = new AbortController(), cancel = jest.fn();
  let started: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  responses.set(`/repos/owner/repo/git/trees/${treeSha}`, new Response(new ReadableStream({ start() { started(); }, cancel })));
  const pending = fetchGithubRiskEvidence('https://github.com/owner/repo', true, controller.signal);
  await ready; await Promise.resolve();
  // Wait until the collector has reached the tree request, not merely fixture construction.
  while (!fetchMock.mock.calls.some(([url]) => url.includes('/git/trees/'))) await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toThrow(); expect(cancel).toHaveBeenCalledTimes(1);
});
it('refuses an already aborted request before fetching', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(fetchGithubRiskEvidence('https://github.com/owner/repo', false, controller.signal)).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
