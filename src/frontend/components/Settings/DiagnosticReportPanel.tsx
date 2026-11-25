'use client';

import { useState } from 'react';
import { Alert, Box, Button, Stack, TextField, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useTimeout } from '@/frontend/hooks/timing';
import { formatDiagnosticReport } from '@/shared/types/diagnosticReport';

type Status = 'idle' | 'creating' | 'failed';

/** Settings → Privacy & usage: a report the person reads and shares themselves. Nothing is sent. */
export default function DiagnosticReportPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>('idle');
  const [report, setReport] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  useTimeout(() => setCopy('idle'), copy === 'copied' ? 2000 : null);

  const create = async () => {
    setStatus('creating');
    setCopy('idle');
    try {
      const response = await fetch('/api/diagnostics/report', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`report request returned ${response.status}`);
      setReport(formatDiagnosticReport(await response.json()));
      setStatus('idle');
    } catch {
      setStatus('failed');
    }
  };

  const copyReport = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };

  const saveReport = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `flujo-diagnostic-report-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Box component="section" aria-labelledby="diagnostic-report-title" sx={{ mt: 3 }}>
      <Typography id="diagnostic-report-title" variant="h6" component="h3" sx={{ mb: 1 }}>
        {t('settings.diagnostics.title')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('settings.diagnostics.description')}
      </Typography>
      <Button variant="outlined" onClick={create} disabled={status === 'creating'}>
        {status === 'creating' ? t('settings.diagnostics.creating') : t('settings.diagnostics.create')}
      </Button>
      {status === 'failed' && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {t('settings.diagnostics.failed')}
        </Alert>
      )}
      {report && (
        <Box sx={{ mt: 2 }}>
          <TextField
            label={t('settings.diagnostics.preview')}
            value={report}
            multiline
            fullWidth
            minRows={8}
            slotProps={{ input: { readOnly: true, sx: { fontFamily: 'var(--font-geist-mono)', fontSize: 12 } } }}
          />
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Button onClick={copyReport}>
              {copy === 'copied' ? t('settings.diagnostics.copied') : t('settings.diagnostics.copy')}
            </Button>
            <Button onClick={saveReport}>{t('settings.diagnostics.save')}</Button>
          </Stack>
          {copy === 'failed' && (
            <Alert severity="info" sx={{ mt: 1 }}>
              {t('settings.diagnostics.copyFailed')}
            </Alert>
          )}
        </Box>
      )}
    </Box>
  );
}
