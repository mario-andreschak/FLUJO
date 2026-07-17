/**
 * Unit tests for the GitHub new-issue URL builder (issue #127): encoding, label
 * allowlisting, and length-budget truncation.
 */

import { buildNewIssueUrl, MAX_ISSUE_URL_LENGTH } from '@/frontend/utils/openGitHubIssue';
import { BUG_REPORT_REPO } from '@/shared/types/bugReport';

describe('buildNewIssueUrl', () => {
  it('URL-encodes title and body and targets the FLUJO repo', () => {
    const url = buildNewIssueUrl({ title: 'Crash & burn', body: 'line one\nline two?' });
    expect(url.startsWith(`https://github.com/${BUG_REPORT_REPO}/issues/new?`)).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('title')).toBe('Crash & burn');
    expect(parsed.searchParams.get('body')).toBe('line one\nline two?');
  });

  it('keeps only allowlisted labels (deduped)', () => {
    const url = buildNewIssueUrl({
      title: 't',
      body: 'b',
      labels: ['bug', 'frontend', 'not-a-real-label', 'bug', 'security'],
    });
    const labels = new URL(url).searchParams.get('labels');
    expect(labels).toBe('bug,frontend');
  });

  it('omits the labels param entirely when none are valid', () => {
    const url = buildNewIssueUrl({ title: 't', body: 'b', labels: ['nope', 'invalid'] });
    expect(new URL(url).searchParams.get('labels')).toBeNull();
  });

  it('trims an oversized body under the URL length budget and appends a note', () => {
    const huge = 'x'.repeat(50_000);
    const url = buildNewIssueUrl({ title: 'big', body: huge, labels: ['bug'] });
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    const body = new URL(url).searchParams.get('body') || '';
    expect(body).toContain('truncated');
    expect(body.length).toBeLessThan(huge.length);
  });

  it('respects a custom repo', () => {
    const url = buildNewIssueUrl({ title: 't', body: 'b' }, 'octocat/Hello-World');
    expect(url.startsWith('https://github.com/octocat/Hello-World/issues/new?')).toBe(true);
  });
});
