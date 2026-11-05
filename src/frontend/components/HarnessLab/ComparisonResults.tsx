'use client';

import { useMemo, useState } from 'react';
import { Alert, Box, Chip, Dialog, DialogContent, Divider, FormControlLabel, LinearProgress, Pagination, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography, useMediaQuery, useTheme } from '@mui/material';
import { CancelRounded, CheckCircleRounded, ErrorRounded, HourglassEmptyRounded } from '@mui/icons-material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import { harnessComparisonCaseId, type HarnessComparison, type HarnessComparisonResult } from '@/shared/types/harnessComparison';

const PAGE_SIZE = 25;
const resultStatus = {
  passed: { key: 'harness.compare.cellPassed', color: 'success', icon: <CheckCircleRounded /> },
  failed: { key: 'harness.compare.cellFailed', color: 'warning', icon: <CancelRounded /> },
  error: { key: 'harness.compare.cellError', color: 'error', icon: <ErrorRounded /> },
} as const;

/** A result in plain words. A chip says more than its color, so it still reads without color. */
function ResultDetail({ result, comparison, label, number, onClose }: {
  result: HarnessComparisonResult;
  comparison: HarnessComparison;
  label: string;
  number: number;
  onClose: () => void;
}) {
  const { t, formatList, formatNumber } = useI18n();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const list = (values: string[]) => formatList(values.map((value) => `"${value}"`));
  const reasons = [
    ...(result.missing.length ? [t('harness.compare.whyMissing', { list: list(result.missing) })] : []),
    ...(result.violations.length ? [t('harness.compare.whyViolations', { list: list(result.violations) })] : []),
    ...(result.missingTools.length ? [t('harness.compare.whyMissingTools', { list: list(result.missingTools) })] : []),
    ...(result.forbiddenToolsCalled.length ? [t('harness.compare.whyForbiddenTools', { list: list(result.forbiddenToolsCalled) })] : []),
  ];
  const example = comparison.input.cases.find((item, index) => harnessComparisonCaseId(item, index) === result.caseId);
  const facts: Array<[string, string]> = [
    [t('harness.compare.toolsCalled'), result.toolsCalled.length ? formatList(result.toolsCalled) : t('harness.compare.none')],
    [t('harness.compare.modelsUsed'), result.modelsUsed.length ? formatList(result.modelsUsed) : t('harness.compare.none')],
    ...(result.reportedModels.length ? [[t('harness.compare.reportedModels'), formatList(result.reportedModels)] as [string, string]] : []),
    [t('harness.compare.colCalls'), formatNumber(result.modelCalls)],
    [t('harness.compare.colTokens'), result.tokens === null ? t('harness.compare.notReported') : formatNumber(result.tokens)],
    [t('harness.compare.colTime'), `${formatNumber(result.durationMs / 1000, { maximumFractionDigits: 1 })} s`],
  ];
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" fullScreen={fullScreen}>
      <DialogHeaderActions title={t('harness.compare.detailTitle', { number, variant: label })} onClose={onClose} />
      <Divider />
      <DialogContent>
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          {result.status === 'passed' && <Alert severity="success">{t('harness.compare.whyPassed')}</Alert>}
          {result.status === 'failed' && (
            <Alert severity="warning">
              <Typography variant="subtitle2">{t('harness.compare.why')}</Typography>
              {reasons.map((reason) => <Box key={reason} sx={{ overflowWrap: 'anywhere' }}>{reason}</Box>)}
            </Alert>
          )}
          {result.status === 'error' && (
            <Alert severity="error">
              <Typography variant="subtitle2">{t('harness.compare.whyError')}</Typography>
              <Box sx={{ overflowWrap: 'anywhere' }}>{result.error?.message}</Box>
              {result.error?.code && <Typography variant="caption">{t('harness.compare.errorCode', { code: result.error.code })}</Typography>}
            </Alert>
          )}
          <Box>
            <Typography variant="subtitle2">{t('harness.compare.input')}</Typography>
            <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{example?.input ?? result.caseId}</Typography>
          </Box>
          <Box>
            <Typography variant="subtitle2">{t('harness.compare.answer')}</Typography>
            {result.output
              ? <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>{result.output}</Box>
              : <Typography color="text.secondary">{t('harness.compare.noAnswer')}</Typography>}
          </Box>
          <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'max-content minmax(0, 1fr)' }, columnGap: 2, rowGap: 0.5, m: 0 }}>
            {facts.map(([name, value]) => [
              <Typography key={`${name}-name`} component="dt" variant="body2" color="text.secondary">{name}</Typography>,
              <Typography key={`${name}-value`} component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere' }}>{value}</Typography>,
            ])}
          </Box>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}

export default function ComparisonResults({ comparison }: { comparison: HarnessComparison }) {
  const { t, formatNumber } = useI18n();
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<{ result: HarnessComparisonResult; number: number } | null>(null);
  const { input, results, summary } = comparison;
  const byCell = useMemo(() => new Map(results.map((result) => [`${result.variant}:${result.caseId}`, result])), [results]);
  const unreported = results.some((result) => result.tokens === null);
  const rows = useMemo(() => input.cases
    .map((example, index) => ({ example, number: index + 1, id: harnessComparisonCaseId(example, index) }))
    .filter((row) => !onlyProblems || input.variants.some((_, variant) => {
      const status = byCell.get(`${variant}:${row.id}`)?.status;
      return status === 'failed' || status === 'error';
    })), [byCell, input.cases, input.variants, onlyProblems]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shownPage = Math.min(page, pages);
  const seconds = (ms: number) => `${formatNumber(ms / 1000, { maximumFractionDigits: 1 })} s`;

  return (
    <Stack spacing={3} sx={{ minWidth: 0 }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h6" component="h3" sx={{ mb: 1 }}>{t('harness.compare.summary')}</Typography>
        <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('harness.compare.colVariant')}</TableCell>
                <TableCell>{t('harness.compare.colPassed')}</TableCell>
                <TableCell align="right">{t('harness.compare.colFailed')}</TableCell>
                <TableCell align="right">{t('harness.compare.colErrors')}</TableCell>
                <TableCell align="right">{t('harness.compare.colCalls')}</TableCell>
                <TableCell align="right">{t('harness.compare.colTokens')}</TableCell>
                <TableCell align="right">{t('harness.compare.colTime')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {summary.map((variant) => (
                <TableRow key={variant.variant}>
                  <TableCell sx={{ minWidth: 160, overflowWrap: 'anywhere' }}>{variant.label}</TableCell>
                  <TableCell sx={{ minWidth: 110 }}>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{formatNumber(variant.passed)} / {formatNumber(input.cases.length)}</Typography>
                    <LinearProgress variant="determinate" color="success" value={input.cases.length ? (variant.passed / input.cases.length) * 100 : 0} aria-hidden sx={{ mt: 0.5, height: 4, borderRadius: 2 }} />
                  </TableCell>
                  <TableCell align="right">{formatNumber(variant.failed)}</TableCell>
                  <TableCell align="right">{formatNumber(variant.errors)}</TableCell>
                  <TableCell align="right">{formatNumber(variant.modelCalls)}</TableCell>
                  <TableCell align="right">{formatNumber(variant.tokens)}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{seconds(variant.durationMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        {unreported && <Typography variant="caption" color="text.secondary">{t('harness.compare.tokensPartial')}</Typography>}
      </Box>

      <Box sx={{ minWidth: 0 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="h6" component="h3">{t('harness.compare.examplesResult')}</Typography>
          <FormControlLabel
            control={<Switch checked={onlyProblems} onChange={(event) => { setOnlyProblems(event.target.checked); setPage(1); }} />}
            label={t('harness.compare.onlyProblems')}
          />
        </Stack>
        {rows.length === 0 ? <Typography color="text.secondary">{t('harness.compare.noProblems')}</Typography> : (
          <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 40 }}>#</TableCell>
                  <TableCell sx={{ minWidth: 200 }}>{t('harness.compare.input')}</TableCell>
                  {summary.map((variant) => <TableCell key={variant.variant} sx={{ minWidth: 120, overflowWrap: 'anywhere' }}>{variant.label}</TableCell>)}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.slice((shownPage - 1) * PAGE_SIZE, shownPage * PAGE_SIZE).map(({ example, number, id }) => (
                  <TableRow key={id}>
                    <TableCell>{number}</TableCell>
                    <TableCell sx={{ maxWidth: 360 }}>
                      <Typography variant="body2" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{example.input}</Typography>
                    </TableCell>
                    {summary.map((variant) => {
                      const result = byCell.get(`${variant.variant}:${id}`);
                      if (!result) {
                        return <TableCell key={variant.variant}><Chip size="small" variant="outlined" icon={<HourglassEmptyRounded />} label={t('harness.compare.cellWaiting')} /></TableCell>;
                      }
                      const look = resultStatus[result.status];
                      const label = t(look.key);
                      return (
                        <TableCell key={variant.variant}>
                          <Chip
                            size="small"
                            variant={result.status === 'passed' ? 'outlined' : 'filled'}
                            color={look.color}
                            icon={look.icon}
                            label={label}
                            onClick={() => setOpen({ result, number })}
                            aria-label={t('harness.compare.openDetail', { status: label, number, variant: variant.label })}
                          />
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        {pages > 1 && <Pagination count={pages} page={shownPage} size="small" onChange={(_, next) => setPage(next)} sx={{ mt: 1 }} />}
      </Box>

      {open && (
        <ResultDetail
          result={open.result}
          comparison={comparison}
          number={open.number}
          label={summary[open.result.variant]?.label ?? ''}
          onClose={() => setOpen(null)}
        />
      )}
    </Stack>
  );
}
