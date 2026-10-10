const fetchSource = jest.fn(), runScanner = jest.fn();
jest.mock('@/backend/services/mcp/securityReview/githubSource', () => {
  const actual = jest.requireActual('@/backend/services/mcp/securityReview/githubSource');
  return { ...actual, fetchGithubReviewSource: (...args: unknown[]) => fetchSource(...args) };
});
jest.mock('@/backend/services/mcp/securityReview/runner', () => ({ runSkillSpector: (...args: unknown[]) => runScanner(...args) }));
import { reviewMcpGithubSource } from '@/backend/services/mcp/securityReview/review';
import { UnsupportedReviewSource } from '@/backend/services/mcp/securityReview/githubSource';
const source = { repositoryUrl: 'https://github.com/a/b', revision: 'a'.repeat(40), digest: 'b'.repeat(64), fileCount: 1, bytes: 5 };
const files = [{ path: 'SKILL.md', content: Buffer.from('hello') }];
const result = () => ({ stdout: JSON.stringify({ metadata: { skillspector_version: '2.12.0', llm_requested: false, meta_analysis_applied: false }, analysis_completeness: { is_complete: true, status: 'complete', scope_exclusions: [], ledger_exceptions: [], analyzer_statuses: [], limitations: [] }, execution_successful: true, risk_assessment: { score: 10, severity: 'LOW' }, issues: [], suppressed_count: 0 }), exitCode: 0, imageId: `sha256:${'c'.repeat(64)}` });
beforeEach(() => {
  jest.resetAllMocks();
  fetchSource.mockResolvedValue({ source, files });
  runScanner.mockResolvedValue(result());
});
it('passes only captured files and cancellation signal to the scanner', async () => {
  expect((await reviewMcpGithubSource(source.repositoryUrl)).status).toBe('reviewed');
  expect(runScanner).toHaveBeenCalledWith(files, expect.any(AbortSignal));
});
it('does not start the scanner on incomplete source', async () => {
  fetchSource.mockRejectedValue(new UnsupportedReviewSource('LFS is unsupported.'));
  expect(await reviewMcpGithubSource(source.repositoryUrl)).toMatchObject({ status: 'unsupported', message: 'LFS is unsupported.' });
  expect(runScanner).not.toHaveBeenCalled();
});
it('hides source and scanner failure details', async () => {
  runScanner.mockRejectedValue(new Error('secret-token private filesystem path'));
  const review = await reviewMcpGithubSource(source.repositoryUrl);
  expect(review.status).toBe('unavailable');
  expect(JSON.stringify(review)).not.toContain('secret-token');
});
it('holds the shared slot until an aborted owned scanner has finished cleanup', async () => {
  let finish: (value: ReturnType<typeof result>) => void = () => { throw new Error('Missing scanner'); };
  let started: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  runScanner.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; started(); }));
  const controller = new AbortController();
  const first = reviewMcpGithubSource(source.repositoryUrl, undefined, controller.signal);
  await ready;
  controller.abort();
  expect(runScanner.mock.calls[0][1].aborted).toBe(true);
  expect((await reviewMcpGithubSource(source.repositoryUrl)).status).toBe('unavailable');
  expect(runScanner).toHaveBeenCalledTimes(1);
  finish(result());
  expect((await first).status).toBe('cancelled');
  expect((await reviewMcpGithubSource(source.repositoryUrl)).status).toBe('reviewed');
});
it('propagates request cancellation into source fetch without starting the scanner', async () => {
  fetchSource.mockImplementationOnce((_url: string, _revision: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const controller = new AbortController();
  const pending = reviewMcpGithubSource(source.repositoryUrl, undefined, controller.signal);
  controller.abort();
  expect((await pending).status).toBe('cancelled');
  expect(runScanner).not.toHaveBeenCalled();
});
it('enforces the shared deadline during source acquisition', async () => {
  jest.useFakeTimers();
  try {
    fetchSource.mockImplementationOnce((_url: string, _revision: string, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true })));
    const pending = reviewMcpGithubSource(source.repositoryUrl);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(await pending).toMatchObject({ status: 'cancelled', message: 'Source review exceeded its time limit.' });
    expect(runScanner).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});
