'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { getSelectedWorkspace, onWorkspaceChanged, withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type { McpSecurityReview } from '@/shared/mcpSecurityReview';

function repositoryTarget(value: string): string | null {
  try {
    const input = value.trim();
    const url = new URL(input);
    if (!/^https:\/\/github\.com\/[^?#%\s]+$/i.test(input) || url.protocol !== 'https:' || url.host !== 'github.com'
      || url.username || url.password || url.search || url.hash || input.split('/').some(part => part === '.' || part === '..')) return null;
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,38})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(url.pathname);
    if (!match || match[2] === '.' || match[2] === '..') return null;
    return `https://github.com/${match[1]}/${match[2]}`.toLowerCase();
  } catch { return null; }
}

function isReview(value: unknown, target: string): value is McpSecurityReview {
  if (!value || typeof value !== 'object') return false;
  const review = value as McpSecurityReview;
  if (!['reviewed', 'partial', 'unsupported', 'unavailable', 'cancelled'].includes(review.status)
    || !Array.isArray(review.limitations) || !review.limitations.every(item => typeof item === 'string')) return false;
  if ((review.status === 'reviewed' || review.status === 'partial') && (!review.source || !review.scanner)) return false;
  if (review.source && (repositoryTarget(review.source.repositoryUrl) !== target
    || typeof review.source.revision !== 'string' || typeof review.source.digest !== 'string'
    || !Number.isFinite(review.source.fileCount) || !Number.isFinite(review.source.bytes))) return false;
  if (review.scanner && (review.scanner.name !== 'SkillSpector' || review.scanner.version !== '2.12.0'
    || review.scanner.mode !== 'static' || review.scanner.dependencyLookup !== 'offline')) return false;
  if (review.risk && (!Number.isFinite(review.risk.score) || typeof review.risk.severity !== 'string')) return false;
  if (review.findings && (!Array.isArray(review.findings) || !review.findings.every(item => item
    && typeof item.severity === 'string' && typeof item.category === 'string' && typeof item.file === 'string'
    && typeof item.message === 'string' && (item.line === undefined || Number.isFinite(item.line))))) return false;
  return true;
}

/** Assistive evidence only: no install, consent, model, or tool callbacks. */
export default function McpSecurityReviewPanel({ repositoryUrl }: { repositoryUrl: string }) {
  const { t } = useI18n();
  const headingId = useId();
  const target = repositoryTarget(repositoryUrl);
  const currentUrl = useRef(repositoryUrl);
  currentUrl.current = repositoryUrl;
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<{
    url: string; workspace: string; pending?: boolean; review?: McpSecurityReview;
  } | null>(null);

  useEffect(() => {
    setState(null);
    const unsubscribe = onWorkspaceChanged(() => {
      request.current?.abort();
      request.current = null;
      setState(null);
    });
    return () => {
      unsubscribe();
      request.current?.abort();
      request.current = null;
    };
  }, [repositoryUrl]);

  const visible = state?.url === repositoryUrl && state.workspace === getSelectedWorkspace() ? state : null;
  const pending = Boolean(visible?.pending);
  const review = visible?.review;

  async function startReview() {
    if (!target || request.current) return;
    const url = repositoryUrl;
    const workspace = getSelectedWorkspace();
    const controller = new AbortController();
    request.current = controller;
    setState({ url, workspace, pending: true });
    const isCurrent = () => request.current === controller && !controller.signal.aborted
      && currentUrl.current === url && getSelectedWorkspace() === workspace;
    try {
      const response = await fetch(withWorkspaceUrl('/api/mcp/security-review', workspace), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositoryUrl: target }), signal: controller.signal,
      });
      const body: unknown = await response.json();
      const envelope = body as { success?: boolean; review?: unknown } | null;
      if (!response.ok || envelope?.success !== true || !isReview(envelope.review, target)) throw new Error('Review unavailable');
      if (isCurrent()) setState({ url, workspace, review: envelope.review });
    } catch {
      if (isCurrent()) setState({ url, workspace, review: { status: 'unavailable', message: '', limitations: [] } });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  function cancelReview() {
    request.current?.abort();
    request.current = null;
    setState({ url: repositoryUrl, workspace: getSelectedWorkspace(), review: { status: 'cancelled', message: '', limitations: [] } });
  }

  const statusKeys = {
    reviewed: 'mcp.securityReview.reviewed', partial: 'mcp.securityReview.partial',
    unsupported: 'mcp.securityReview.unsupported', unavailable: 'mcp.securityReview.unavailable', cancelled: 'mcp.securityReview.cancelled',
  } as const;
  const severityLabel = (severity: string) => severity.toUpperCase() === 'SAFE' ? t('mcp.securityReview.lowestRisk') : severity;

  return (
    <Box component="section" aria-labelledby={headingId} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, mb: 2 }}>
      <Stack spacing={1}>
        <Typography id={headingId} variant="subtitle2">{t('mcp.securityReview.title')}</Typography>
        <Typography variant="body2" color="text.secondary">{t('mcp.securityReview.description')}</Typography>
        {!target && <Typography variant="body2">{t('mcp.securityReview.unsupported')}</Typography>}
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button size="small" variant="outlined" disabled={!target || pending} onClick={startReview}>
            {t(pending ? 'mcp.securityReview.reviewing' : 'mcp.securityReview.button')}
          </Button>
          {pending && <Button size="small" onClick={cancelReview}>{t('mcp.securityReview.cancel')}</Button>}
        </Box>
        <Box role="status" aria-live="polite" aria-busy={pending}>
          {review && <Alert severity={review.status === 'partial' || review.status === 'unavailable' ? 'warning' : 'info'}>
            {t(statusKeys[review.status])}
          </Alert>}
        </Box>
        {review?.status === 'unavailable' && <Button component="a" href="/docs" size="small" sx={{ alignSelf: 'flex-start' }}>{t('mcp.securityReview.help')}</Button>}
        {review?.source && <Box sx={{ overflowWrap: 'anywhere' }}>
          <Typography variant="body2">{t('mcp.securityReview.revision', { revision: review.source.revision })}</Typography>
          <Typography variant="body2">{t('mcp.securityReview.coverage', { files: review.source.fileCount, bytes: review.source.bytes })}</Typography>
          <Typography variant="caption">{t('mcp.securityReview.digest', { digest: review.source.digest })}</Typography>
        </Box>}
        {review?.scanner && <Typography variant="body2">{t('mcp.securityReview.scanner', { version: review.scanner.version })}</Typography>}
        {review?.risk && <Typography variant="body2">{t('mcp.securityReview.risk', { severity: severityLabel(review.risk.severity), score: review.risk.score })}</Typography>}
        {review?.findings && <Box>
          <Typography variant="subtitle2">{t('mcp.securityReview.findings')}</Typography>
          {review.findings.length === 0 && <Typography variant="body2">{t('mcp.securityReview.noFindings')}</Typography>}
          {review.findings.map((finding, index) => <Box key={index} sx={{ mt: 1, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            <Typography variant="body2">{severityLabel(finding.severity)} · {finding.category} · {finding.file}{finding.line === undefined ? '' : `:${finding.line}`}</Typography>
            <Typography variant="body2">{finding.message}</Typography>
          </Box>)}
        </Box>}
        {!!review?.limitations.length && <Box>
          <Typography variant="subtitle2">{t('mcp.securityReview.limitations')}</Typography>
          <Box component="ul" sx={{ m: 0, pl: 2, overflowWrap: 'anywhere' }}>{review.limitations.map((limitation, index) => <Typography component="li" variant="body2" key={index}>{limitation}</Typography>)}</Box>
        </Box>}
        <Typography variant="caption" color="text.secondary">{t('mcp.securityReview.disclaimer')}</Typography>
      </Stack>
    </Box>
  );
}
