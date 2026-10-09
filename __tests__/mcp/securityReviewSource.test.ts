import { createHash } from 'node:crypto';
import { canonicalGithubRepository, fetchGithubReviewSource, validateReviewPath } from '@/backend/services/mcp/securityReview/githubSource';

const revision = 'a'.repeat(40), treeSha = 'b'.repeat(40);
const signal = () => new AbortController().signal;
const content = Buffer.from('console.log("untrusted source is never executed")\n');
const blobSha = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
const entry = () => ({ path: 'index.js', type: 'blob', mode: '100644', sha: blobSha, size: content.length });
const fixtures = (overrides: Record<string, unknown> = {}): Record<string, unknown>[] => [
  { sha: revision, commit: { tree: { sha: treeSha } } },
  { sha: treeSha, truncated: false, tree: [entry()], ...overrides },
  { sha: blobSha, encoding: 'base64', size: content.length, content: content.toString('base64') },
];
const originalFetch = global.fetch;
let fetchMock: jest.Mock;
beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock; });
afterAll(() => { global.fetch = originalFetch; });
function respond(values: unknown[]) { for (const value of values) fetchMock.mockResolvedValueOnce(Response.json(value)); }

it('captures exact verified bytes and a deterministic digest without credential headers or redirects', async () => {
  respond([...fixtures(), ...fixtures()]);
  const first = await fetchGithubReviewSource('https://github.com/Owner/Repo.git/', revision, signal());
  const second = await fetchGithubReviewSource('https://github.com/owner/repo', revision, signal());
  expect(first).toEqual(second);
  expect(first.files).toEqual([{ path: 'index.js', content }]);
  expect(first.source).toMatchObject({ repositoryUrl: 'https://github.com/owner/repo', revision, fileCount: 1, bytes: content.length });
  expect(first.source.digest).toMatch(/^[a-f0-9]{64}$/);
  for (const [url, options] of fetchMock.mock.calls) {
    expect(url).toMatch(/^https:\/\/api\.github\.com\/repos\/owner\/repo\//);
    expect(options).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(options.headers.authorization).toBeUndefined();
  }
});

it.each(['not a URL', 'https://github.com/a/private/../b', 'http://github.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a/b?token=x', 'https://user@github.com/a/b', 'https://github.com.evil.test/a/b', 'https://github.com/a/b#x', 'https://github.com/a/b%2fprivate'])('rejects unsupported URL %s', value => {
  expect(() => canonicalGithubRepository(value)).toThrow();
});
it.each(['../secret', '/absolute', 'a\\b', 'a/.git/config', 'CON.js', 'a/./b', 'a//b', 'a:b', 'dir/file.', 'dir/file ', 'a\0b'])('rejects unsupported path %s', value => {
  expect(() => validateReviewPath(value)).toThrow();
});
it('checks archive limits in UTF-8 bytes rather than characters', () => {
  expect(validateReviewPath('é'.repeat(50))).toBe('é'.repeat(50));
  expect(() => validateReviewPath('é'.repeat(51))).toThrow(/archive byte limits/);
  expect(validateReviewPath(`${'é'.repeat(77)}/a`)).toBe(`${'é'.repeat(77)}/a`);
  expect(() => validateReviewPath(`${'é'.repeat(78)}/a`)).toThrow(/archive byte limits/);
  expect(() => validateReviewPath(`a/${'é'.repeat(51)}`)).toThrow(/archive byte limits/);
});
it.each([
  { truncated: true },
  { tree: [{ ...entry(), mode: '120000' }] },
  { tree: [{ ...entry(), type: 'commit', mode: '160000' }] },
  { tree: [entry(), { ...entry(), path: 'INDEX.js' }] },
  { tree: [{ ...entry(), size: 1024 * 1024 + 1 }] },
  { tree: Array.from({ length: 257 }, (_, index) => ({ ...entry(), path: `file${index}` })) },
  { tree: Array.from({ length: 9 }, (_, index) => ({ ...entry(), path: `file${index}`, size: 1024 * 1024 })) },
  { tree: [{ ...entry(), path: 'Dir/x' }, { path: 'dir', mode: '040000', type: 'tree', sha: treeSha }] },
])('refuses incomplete/unmaterializable tree %j before blob reads', async overrides => {
  respond(fixtures(overrides));
  await expect(fetchGithubReviewSource('https://github.com/a/b', revision, signal())).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('rejects different commit identity', async () => {
  respond([{ ...fixtures()[0], sha: 'c'.repeat(40) }]);
  await expect(fetchGithubReviewSource('https://github.com/a/b', revision, signal())).rejects.toThrow(/different revision/);
});
it('rejects content that does not match the Git blob', async () => {
  const values = fixtures(); values[2] = { ...values[2], content: Buffer.alloc(content.length).toString('base64') };
  respond(values);
  await expect(fetchGithubReviewSource('https://github.com/a/b', revision, signal())).rejects.toThrow(/do not match/);
});
it('rejects LFS pointers rather than scanning pointer text', async () => {
  const lfs = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:x\n');
  const sha = createHash('sha1').update(`blob ${lfs.length}\0`).update(lfs).digest('hex');
  respond([fixtures()[0], { sha: treeSha, truncated: false, tree: [{ ...entry(), sha, size: lfs.length }] }, { sha, size: lfs.length, encoding: 'base64', content: lfs.toString('base64') }]);
  await expect(fetchGithubReviewSource('https://github.com/a/b', revision, signal())).rejects.toThrow(/LFS/);
});
it('bounds actual streamed API bytes and cancels the reader', async () => {
  const cancel = jest.fn();
  fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel })));
  await expect(fetchGithubReviewSource('https://github.com/a/b', revision, signal())).rejects.toThrow(/response exceeds/);
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('does not fetch after cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(fetchGithubReviewSource('https://github.com/a/b', revision, controller.signal)).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
