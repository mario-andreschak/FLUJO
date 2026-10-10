'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, FormControlLabel, Stack, TextField, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { getSelectedWorkspace, onWorkspaceChanged, withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import { supportsMcpModelRiskAssessment, type McpModelRiskAssessment } from '@/shared/mcpModelRiskAssessment';
import type { Model } from '@/shared/types/model';

function repositoryTarget(value: string): string | null {
  try {
    const input = value.trim();
    const url = new URL(input);
    if (!/^https:\/\/github\.com\/[^?#%\s]+$/i.test(input) || url.host !== 'github.com'
      || url.username || url.password || input.split('/').some(part => part === '.' || part === '..')) return null;
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,38})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(url.pathname);
    return match && !['.', '..'].includes(match[2]) ? `https://github.com/${match[1]}/${match[2]}`.toLowerCase() : null;
  } catch { return null; }
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keys = (value: RecordValue, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const count = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const date = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)));
const limitationKeys = ['signalsOnly', 'sampleOnly', 'sourceUnavailable', 'sourceTruncated', 'authorUnavailable', 'issuesUnavailable', 'repositorySignalsUnavailable'] as const;

/** Reject unrelated or malformed evidence rather than attributing it to the selected repository/model. */
function isAssessment(value: unknown, target: string, modelId: string, includeSource: boolean): value is McpModelRiskAssessment {
  if (!record(value) || !keys(value, ['status', 'reason', 'source', 'model', 'assessment'])
    || !['assessed', 'unavailable', 'unsupported', 'cancelled'].includes(String(value.status))) return false;
  if (value.reason !== undefined && !['busy', 'model', 'credentials', 'github', 'response', 'timeout'].includes(String(value.reason))) return false;
  if (value.model !== undefined && (!record(value.model) || !keys(value.model, ['id', 'name'])
    || value.model.id !== modelId || !text(value.model.name, 200))) return false;
  if (value.source !== undefined) {
    const source = value.source;
    if (!record(source) || !keys(source, ['repositoryUrl', 'revision', 'capturedAt', 'evidenceDigest', 'repository', 'author', 'limitations', 'fileCount', 'bytes'])
      || typeof source.repositoryUrl !== 'string' || repositoryTarget(source.repositoryUrl) !== target
      || typeof source.revision !== 'string' || !/^[a-f0-9]{40}$/.test(source.revision)
      || typeof source.evidenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(source.evidenceDigest)
      || source.capturedAt === null || !date(source.capturedAt) || source.capturedAt === undefined
      || typeof source.fileCount !== 'number' || !count(source.fileCount) || source.fileCount > 6
      || typeof source.bytes !== 'number' || !count(source.bytes) || source.bytes > 48 * 1024
      || !Array.isArray(source.limitations) || source.limitations.length > limitationKeys.length
      || !source.limitations.every(item => limitationKeys.includes(item))) return false;
    if (!includeSource && (source.fileCount !== 0 || source.bytes !== 0 || !source.limitations.includes('signalsOnly'))) return false;
    if (includeSource && !source.limitations.includes('sampleOnly')) return false;
    const repository = source.repository;
    const author = source.author;
    if (!record(repository) || !keys(repository, ['stars', 'forks', 'lastCommitAt', 'openIssues', 'closedIssues', 'openIssueRatio'])
      || !['stars', 'forks', 'openIssues', 'closedIssues'].every(key => count(repository[key])) || !date(repository.lastCommitAt)
      || !(repository.openIssueRatio === null || (typeof repository.openIssueRatio === 'number' && Number.isFinite(repository.openIssueRatio)
        && repository.openIssueRatio >= 0 && repository.openIssueRatio <= 1))
      || !record(author) || !keys(author, ['login', 'type', 'followers', 'publicRepositories', 'createdAt', 'accountAgeDays'])
      || !text(author.login, 100) || !['User', 'Organization', 'unknown'].includes(String(author.type))
      || !['followers', 'publicRepositories', 'accountAgeDays'].every(key => count(author[key])) || !date(author.createdAt)) return false;
  }
  if (value.assessment !== undefined) {
    const assessment = value.assessment;
    if (!record(assessment) || !keys(assessment, ['score', 'rationale', 'flags'])
      || typeof assessment.score !== 'number' || !Number.isInteger(assessment.score) || assessment.score < 0 || assessment.score > 100
      || !text(assessment.rationale, 2048) || !assessment.rationale.trim()
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(assessment.rationale)
      || !Array.isArray(assessment.flags) || assessment.flags.length > 12
      || !assessment.flags.every(flag => text(flag, 256) && flag.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(flag))) return false;
  }
  return value.status === 'assessed'
    ? value.reason === undefined && value.source !== undefined && value.model !== undefined && value.assessment !== undefined
    : value.assessment === undefined;
}

type Choice = { id: string; name: string };
function eligibleModels(value: unknown): Choice[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid model list');
  const seen = new Set<string>();
  return value.flatMap(model => {
    if (!record(model) || !text(model.id, 256) || !text(model.name, 256)
      || (model.outputModalities !== undefined && (!Array.isArray(model.outputModalities) || !model.outputModalities.every(item => typeof item === 'string')))
      || !supportsMcpModelRiskAssessment(model as unknown as Model) || seen.has(String(model.id))) return [];
    seen.add(String(model.id));
    return [{ id: String(model.id), name: String(model.displayName || model.name).slice(0, 256) }];
  });
}

type PanelState = {
  url: string; workspace: string; models: Choice[]; modelId: string; includeSource: boolean;
  loading?: boolean; loadError?: boolean; pending?: boolean; review?: McpModelRiskAssessment;
};

/** A separate optional advisory action; this component cannot install or grant execution consent. */
export default function McpModelRiskAssessmentPanel({ repositoryUrl, active = true }: { repositoryUrl: string; active?: boolean }) {
  const { t } = useI18n();
  const headingId = useId();
  const target = repositoryTarget(repositoryUrl);
  const currentUrl = useRef(repositoryUrl);
  currentUrl.current = repositoryUrl;
  const modelsRequest = useRef<AbortController | null>(null);
  const reviewRequest = useRef<AbortController | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [state, setState] = useState<PanelState | null>(null);
  const abort = useCallback(() => {
    modelsRequest.current?.abort(); modelsRequest.current = null;
    reviewRequest.current?.abort(); reviewRequest.current = null;
  }, []);
  useEffect(() => {
    setState(null);
    const unsubscribe = onWorkspaceChanged(() => { abort(); setState(null); });
    return () => { unsubscribe(); abort(); };
  }, [abort, repositoryUrl]);
  useEffect(() => {
    if (active) return;
    abort();
    setState(previous => previous && (previous.loading || previous.pending) ? {
      ...previous, loading: false, pending: false,
      loadError: previous.loading || previous.loadError,
      review: previous.pending ? { status: 'cancelled' } : previous.review,
    } : previous);
  }, [abort, active]);
  const visible = state?.url === repositoryUrl && state.workspace === getSelectedWorkspace() ? state : null;

  async function open() {
    if (!activeRef.current || !target || modelsRequest.current) return;
    abort();
    const url = repositoryUrl;
    const workspace = getSelectedWorkspace();
    const controller = new AbortController();
    modelsRequest.current = controller;
    const initial = { url, workspace, models: [], modelId: '', includeSource: false };
    setState({ ...initial, loading: true });
    const isCurrent = () => activeRef.current && modelsRequest.current === controller && !controller.signal.aborted
      && currentUrl.current === url && getSelectedWorkspace() === workspace;
    try {
      const response = await fetch(withWorkspaceUrl('/api/model', workspace), { signal: controller.signal });
      if (!response.ok) throw new Error('Models unavailable');
      const models = eligibleModels(await response.json());
      if (isCurrent()) setState({ ...initial, models });
    } catch { if (isCurrent()) setState({ ...initial, loadError: true }); }
    finally { if (modelsRequest.current === controller) modelsRequest.current = null; }
  }

  function changeSelection(update: Partial<Pick<PanelState, 'modelId' | 'includeSource'>>) {
    if (!activeRef.current) return;
    reviewRequest.current?.abort(); reviewRequest.current = null;
    setState(previous => previous ? { ...previous, ...update, pending: false, review: undefined } : null);
  }

  async function assess() {
    if (!activeRef.current || !target || !visible?.modelId || reviewRequest.current || !visible.models.some(model => model.id === visible.modelId)) return;
    const snapshot = visible;
    const controller = new AbortController();
    reviewRequest.current = controller;
    setState({ ...snapshot, pending: true, review: undefined });
    const isCurrent = () => activeRef.current && reviewRequest.current === controller && !controller.signal.aborted
      && currentUrl.current === snapshot.url && getSelectedWorkspace() === snapshot.workspace;
    try {
      const response = await fetch(withWorkspaceUrl('/api/mcp/model-risk-assessment', snapshot.workspace), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ repositoryUrl: target, modelId: snapshot.modelId, includeSource: snapshot.includeSource }),
      });
      const body: unknown = await response.json();
      if (!response.ok || !record(body) || !keys(body, ['success', 'review']) || body.success !== true
        || !isAssessment(body.review, target, snapshot.modelId, snapshot.includeSource)) throw new Error('Assessment unavailable');
      if (isCurrent()) setState({ ...snapshot, review: body.review });
    } catch { if (isCurrent()) setState({ ...snapshot, review: { status: 'unavailable' } }); }
    finally { if (reviewRequest.current === controller) reviewRequest.current = null; }
  }

  function cancel() {
    reviewRequest.current?.abort(); reviewRequest.current = null;
    setState(previous => previous ? { ...previous, pending: false, review: { status: 'cancelled' } } : null);
  }
  const review = visible?.review;
  const source = review?.source;
  const unknown = t('mcp.modelRisk.unknown');
  const signal = (value: number | string | null) => value === null ? unknown : value;
  return <Box hidden={!active} inert={!active} component="section" aria-labelledby={headingId} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, mb: 2 }}>
    <Stack spacing={1}>
      <Typography id={headingId} variant="subtitle2">{t('mcp.modelRisk.title')}</Typography>
      <Typography variant="body2">{t('mcp.modelRisk.description')}</Typography>
      {!target && <Typography variant="body2">{t('mcp.securityReview.unsupported')}</Typography>}
      <Button size="small" variant="outlined" onClick={open} disabled={!active || !target || !!visible?.loading} sx={{ alignSelf: 'flex-start' }}>{t('mcp.modelRisk.open')}</Button>
      {visible && <>
        <Typography variant="body2">{t('mcp.modelRisk.privacy')}</Typography>
        <Typography variant="caption">{t('mcp.modelRisk.supported')}</Typography>
        <TextField select slotProps={{ select: { native: true } }} size="small" label={t('mcp.modelRisk.model')} value={visible.modelId}
          disabled={visible.loading} onChange={event => changeSelection({ modelId: event.target.value })}>
          <option value="">{t('mcp.modelRisk.choose')}</option>
          {visible.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </TextField>
        <FormControlLabel control={<Checkbox disabled={visible.loading} checked={visible.includeSource} onChange={event => changeSelection({ includeSource: event.target.checked })} />}
          label={t('mcp.modelRisk.sourceOptIn')} />
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button size="small" onClick={assess} disabled={!active || !visible.modelId || visible.loading || visible.pending}>{t(visible.pending ? 'mcp.modelRisk.assessing' : 'mcp.modelRisk.assess')}</Button>
          {visible.pending && <Button size="small" onClick={cancel}>{t('mcp.modelRisk.cancel')}</Button>}
          <Button size="small" onClick={() => { abort(); setState(null); }}>{t('mcp.modelRisk.hide')}</Button>
        </Box>
      </>}
      <Box role="status" aria-live="polite" aria-busy={Boolean(visible?.pending || visible?.loading)}>
        {visible?.loading && <Typography variant="body2">{t('mcp.modelRisk.loading')}</Typography>}
        {visible?.loadError && <Alert severity="warning">{t('mcp.modelRisk.loadError')}</Alert>}
        {visible && !visible.loading && !visible.loadError && !visible.models.length && <Alert severity="info">{t('mcp.modelRisk.noModels')}</Alert>}
        {review && <Alert severity={review.status === 'unavailable' ? 'warning' : 'info'}>{t(`mcp.modelRisk.${review.status}`)}</Alert>}
        {review?.reason && <Typography variant="body2">{t(`mcp.modelRisk.reason.${review.reason}`)}</Typography>}
      </Box>
      {review?.assessment && <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        <Typography variant="body2">{t('mcp.modelRisk.score', { score: review.assessment.score })}</Typography>
        <Typography variant="body2">{review.assessment.rationale}</Typography>
        <Box component="ul" sx={{ m: 0, pl: 2 }}>{review.assessment.flags.map((flag, index) => <Typography component="li" variant="body2" key={index}>{flag}</Typography>)}</Box>
      </Box>}
      {source && <Box sx={{ overflowWrap: 'anywhere' }}>
        <Typography variant="body2">{t('mcp.securityReview.revision', { revision: source.revision })}</Typography>
        <Typography variant="body2">{t('mcp.modelRisk.capture', { date: source.capturedAt })}</Typography>
        <Typography variant="caption">{t('mcp.modelRisk.digest', { digest: source.evidenceDigest })}</Typography>
        <Typography variant="body2">{t('mcp.modelRisk.repositorySignals', { stars: signal(source.repository.stars), forks: signal(source.repository.forks), commit: signal(source.repository.lastCommitAt) })}</Typography>
        <Typography variant="body2">{t('mcp.modelRisk.issueSignals', { open: signal(source.repository.openIssues), closed: signal(source.repository.closedIssues), ratio: source.repository.openIssueRatio === null ? unknown : `${Math.round(source.repository.openIssueRatio * 100)}%` })}</Typography>
        <Typography variant="body2">{t('mcp.modelRisk.authorSignals', { login: source.author.login, followers: signal(source.author.followers), repositories: signal(source.author.publicRepositories), age: signal(source.author.accountAgeDays) })}</Typography>
        <Typography variant="body2">{t('mcp.modelRisk.coverage', { files: source.fileCount, bytes: source.bytes })}</Typography>
        <Typography variant="subtitle2">{t('mcp.securityReview.limitations')}</Typography>
        <Box component="ul" sx={{ m: 0, pl: 2 }}>{source.limitations.map((item, index) => <Typography component="li" variant="body2" key={index}>{t(`mcp.modelRisk.limit.${item}`)}</Typography>)}</Box>
      </Box>}
      <Typography variant="caption" color="text.secondary">{t('mcp.modelRisk.disclaimer')}</Typography>
    </Stack>
  </Box>;
}
