import type { McpSecurityReview } from '@/shared/mcpSecurityReview';
import { fetchGithubReviewSource, UnsupportedReviewSource } from './githubSource';
import { normalizeSkillSpectorReport, REVIEW_LIMITATIONS } from './report';
import { runSkillSpector } from './runner';

// All workspaces share one owned scanner process slot; no queue or background run.
declare global {
  var __flujoMcpSourceReviewActive: boolean | undefined;
}
export async function reviewMcpGithubSource(repositoryUrl: string, revision?: string, requestSignal?: AbortSignal): Promise<McpSecurityReview> {
  const failure = (status: McpSecurityReview['status'], message: string, source?: McpSecurityReview['source']): McpSecurityReview => ({ status, message, ...(source ? { source } : {}), limitations: [...REVIEW_LIMITATIONS] });
  if (requestSignal?.aborted) return failure('cancelled', 'Source review was cancelled.');
  if (globalThis.__flujoMcpSourceReviewActive) return failure('unavailable', 'Another source review is running. Try again after it finishes.');
  globalThis.__flujoMcpSourceReviewActive = true;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  requestSignal?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(), 120_000);
  deadline.unref?.();
  let source: McpSecurityReview['source'];
  try {
    const captured = await fetchGithubReviewSource(repositoryUrl, revision, controller.signal);
    source = captured.source;
    controller.signal.throwIfAborted();
    const result = await runSkillSpector(captured.files, controller.signal);
    controller.signal.throwIfAborted();
    return normalizeSkillSpectorReport(result, captured.source);
  } catch (error) {
    if (controller.signal.aborted) return failure('cancelled', requestSignal?.aborted ? 'Source review was cancelled.' : 'Source review exceeded its time limit.', source);
    if (error instanceof UnsupportedReviewSource) return failure('unsupported', error.message, source);
    return failure('unavailable', 'Source review is unavailable. Check the locally provisioned scanner and public GitHub availability.', source);
  } finally {
    clearTimeout(deadline);
    requestSignal?.removeEventListener('abort', onAbort);
    globalThis.__flujoMcpSourceReviewActive = false;
  }
}
