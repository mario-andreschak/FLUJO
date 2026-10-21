'use client';

import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Chip, Divider, Stack, Typography } from '@mui/material';
import { ExpandMoreRounded } from '@mui/icons-material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type { HarnessRun, HarnessCandidate } from '@/shared/types/harness';
import { contrastHarnessCandidates } from '@/backend/services/harness/contrast';

function CandidateContrast({ parent, candidate }: { parent: HarnessCandidate; candidate: HarnessCandidate }) {
  const { t } = useI18n();
  const contrast = contrastHarnessCandidates(parent, candidate);
  return <Box component="details">
    <Box component="summary">{t('harness.contrast')}</Box>
    <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>
      {[...contrast.instructionChange.removed.map(line => `− ${line}`), ...contrast.instructionChange.added.map(line => `+ ${line}`)].join('\n')}
    </Box>
    {contrast.pairedTasks.map(pair => <Box key={pair.caseId} sx={{ mb: 2 }}>
      <Typography variant="subtitle2">{pair.caseId} · {t('harness.requiredScore')}: {pair.qualityDelta > 0 ? '+' : ''}{Math.round(pair.qualityDelta * 100)}%</Typography>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        {[pair.before, pair.after].map((result, index) => <Box key={index} sx={{ flex: 1, minWidth: 0, bgcolor: 'action.hover', p: 2 }}>
          <Typography variant="subtitle2">{t(index ? 'harness.candidate' : 'harness.parent')}</Typography>
          <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.output}</Typography>
          <Typography variant="body2">{result.explanation}</Typography>
          <Typography variant="caption">{pair.tokens[index] ?? '—'} tokens · {(pair.durationMs[index] / 1000).toFixed(1)} s</Typography>
        </Box>)}
      </Stack>
    </Box>)}
  </Box>;
}

export default function RunEvidence({ run, busy, enabled, workspace, onPromote }: {
  run: HarnessRun; busy: boolean; enabled: boolean; workspace: string; onPromote: () => void;
}) {
  const { t } = useI18n();
  const scopeKeys = { baseline: 'harness.baseline', general: 'harness.general', domain: 'harness.domainScope', composed: 'harness.composed' } as const;
  const unknownCalls = run.unknownUsageCalls + (run.modelCallsStarted ?? run.callsStarted) - (run.modelCallsCompleted ?? run.callsCompleted);
  return <Stack spacing={2} sx={{ minWidth: 0 }}>
    <Typography variant="h5" component="h2">{t('harness.evidence')}</Typography>
    <Typography>{run.input.name}</Typography>
    {run.input.rubric && <Typography variant="body2">{t('harness.rubric')}: {run.input.rubric}</Typography>}
    <Typography variant="caption">{t('harness.usage')}</Typography>
    <Typography>{run.callsCompleted} / {run.callsStarted} · {run.totalTokens.toLocaleString()} · {(run.modelTimeMs / 1000).toFixed(1)} s</Typography>
    {run.modelCallsStarted !== undefined && <Typography variant="body2">{t('harness.modelCalls')}: {run.modelCallsCompleted ?? 0} / {run.modelCallsStarted}</Typography>}
    {unknownCalls > 0 && <Typography variant="body2" color="text.secondary">
      {t('harness.unknownUsage')}: {unknownCalls}
    </Typography>}
    <Typography variant="body2">{run.model.name} · {run.model.authentication}</Typography>
    {run.error && <Alert severity="error">{run.error}</Alert>}
    {run.decision && <Alert severity={run.decision.eligible ? 'success' : 'info'}>{run.decision.reasons.join(' ')}</Alert>}
    {run.candidates.map(candidate => <Accordion key={candidate.id} defaultExpanded={candidate.id === run.selectedId} disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreRounded />}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography>{t(scopeKeys[candidate.scope])} {candidate.round > 0 ? candidate.round : ''}</Typography>
          {candidate.id === run.selectedId && <Chip size="small" color="primary" label={t('harness.selected')} />}
          {run.frontierIds.includes(candidate.id) && <Chip size="small" variant="outlined" label={t('harness.frontier')} />}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Typography variant="body2">{candidate.rationale}</Typography>
          <Typography variant="caption">{t('harness.characters')}: {candidate.prompt.length}</Typography>
          <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', p: 2, bgcolor: 'action.hover', borderRadius: 1 }}>{candidate.prompt}</Box>
          <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>SHA-256: {candidate.promptHash}</Typography>
          {candidate.parentId && run.candidates.some(item => item.id === candidate.parentId)
            && <CandidateContrast parent={run.candidates.find(item => item.id === candidate.parentId)!} candidate={candidate} />}
          {candidate.probes.map(probe => <Box key={probe.caseId} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
            <Stack spacing={1}>
              <Typography variant="subtitle2">{probe.caseId} · {t(probe.split === 'train' ? 'harness.train' : 'harness.holdout')}</Typography>
              <Typography variant="body2">{t('harness.requiredScore')}: {Math.round(probe.quality * 100)}% · {t('harness.forbiddenScore')}: {Math.round(probe.compliance * 100)}%</Typography>
              <Typography variant="caption">{(probe.durationMs / 1000).toFixed(1)} s · {probe.tokens ?? '—'} tokens</Typography>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{run.input.cases.find(item => item.id === probe.caseId)?.input}</Typography>
              {(probe.missing.length > 0 || probe.violations.length > 0) && <Alert severity="warning">
                {probe.missing.length > 0 && <Box>{t('harness.requiredScore')}: {probe.missing.join(' · ')}</Box>}
                {probe.violations.length > 0 && <Box>{t('harness.forbiddenScore')}: {probe.violations.join(' · ')}</Box>}
              </Alert>}
              <Divider />
              <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{probe.output}</Typography>
              {probe.evaluatorReason && <Typography variant="body2">{probe.evaluatorReason}</Typography>}
              {probe.systemPrompts?.map((prompt, index) => <Box component="details" key={index}>
                <Box component="summary">{t('harness.executedPrompt')} · {prompt.nodeId}</Box>
                <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{prompt.text}</Box>
                <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>{prompt.hash}</Typography>
              </Box>)}
              {probe.toolTrace && <Typography variant="body2">{t('harness.replayedTools')}: {probe.toolTrace.map(item => `${item.name} (${item.matched ? '✓' : '×'})`).join(', ') || '0'}</Typography>}
            </Stack>
          </Box>)}
        </Stack>
      </AccordionDetails>
    </Accordion>)}
    {run.lesson && <Alert severity="info"><Typography variant="subtitle2">{t('harness.lessons')}</Typography>{run.lesson}</Alert>}
    {run.lessons.map(lesson => <Typography key={lesson.sourceId} variant="body2">{lesson.text}</Typography>)}
    {run.decision?.eligible && <Alert severity="warning">{t('harness.review')}</Alert>}
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Button component="a" href={withWorkspaceUrl(`/api/harness/${run.id}?download=1`, workspace)}>{t('harness.export')}</Button>
      {run.decision?.eligible && !run.promotedPromptHash && <Button variant="contained" disabled={busy || !enabled} onClick={onPromote}>{t(run.runtime ? 'harness.activate' : 'harness.promote')}</Button>}
      {run.promotedFlowId && run.promotedPromptHash && <Button component="a" href={withWorkspaceUrl(`/flows?flow=${run.promotedFlowId}&mode=edit`, workspace)}>{t('harness.openAgent')}</Button>}
    {run.activatedVersionId && <Chip color="success" label={t('harness.activated')} />}
    </Stack>
  </Stack>;
}
