"use client";

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Alert,
  Chip,
  CircularProgress,
  Divider,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { ModelTestAttempt, ModelTestResult } from '@/shared/types/model/response';
import { useI18n } from '@/frontend/contexts/I18nContext';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';

export interface ModelTestDialogProps {
  open: boolean;
  modelLabel: string;
  loading: boolean;
  result: ModelTestResult | null;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}

const AttemptBlock = ({ title, attempt }: { title: string; attempt: ModelTestAttempt }) => {
  const { t, formatNumber } = useI18n();
  return <Box sx={{ mb: 2 }}>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
      {attempt.ok ? (
        <CheckCircleIcon color="success" fontSize="small" />
      ) : (
        <ErrorIcon color="error" fontSize="small" />
      )}
      <Typography variant="subtitle2">{title}</Typography>
      {typeof attempt.status === 'number' && (
        <Chip size="small" label={`HTTP ${attempt.status}`} />
      )}
      <Chip size="small" variant="outlined" label={`${formatNumber(attempt.durationMs)} ms`} />
    </Box>

    {attempt.ok ? (
      <Typography variant="body2" color="text.secondary" sx={{ pl: 3 }}>
        {t('models.test.response', { response: attempt.content ? `"${attempt.content}"` : t('models.test.empty') })}
      </Typography>
    ) : (
      <Box sx={{ pl: 3 }}>
        <Typography variant="body2" color="error.main">
          {attempt.error?.message}
        </Typography>
        {(attempt.error?.code || attempt.error?.type) && (
          <Typography variant="caption" color="text.secondary" display="block">
            {attempt.error?.type ? `type: ${attempt.error.type}` : ''}
            {attempt.error?.type && attempt.error?.code ? ' · ' : ''}
            {attempt.error?.code ? `code: ${attempt.error.code}` : ''}
          </Typography>
        )}
        {attempt.error?.retryAfter && (
          <Typography variant="caption" color="text.secondary" display="block">
            retry-after: {attempt.error.retryAfter}s
          </Typography>
        )}
        {attempt.error?.body !== undefined && (
          <Box
            component="pre"
            sx={{
              mt: 0.5,
              p: 1,
              bgcolor: 'action.hover',
              borderRadius: 1,
              fontSize: '0.7rem',
              overflowX: 'auto',
              maxHeight: 160,
            }}
          >
            {JSON.stringify(attempt.error.body, null, 2)}
          </Box>
        )}
      </Box>
    )}
  </Box>;
};

export const ModelTestDialog = ({
  open,
  modelLabel,
  loading,
  result,
  error,
  onClose,
  onRetry,
}: ModelTestDialogProps) => {
  const { t } = useI18n();
  const sdkTitle = result?.provider === 'codex'
    ? t('models.test.codexSdk')
    : t('models.test.openaiSdk');

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogHeaderActions title={t('models.test.title', { model: modelLabel })} onClose={onClose} />
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 3 }}>
            <CircularProgress size={24} />
            <Typography variant="body2">
              {t('models.test.sending')}
            </Typography>
          </Box>
        ) : error ? (
          <Alert severity="error">{error}</Alert>
        ) : result ? (
          <>
            <Alert severity={result.ok ? 'success' : 'warning'} sx={{ mb: 2 }}>
              {result.diagnosis}
            </Alert>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
              {t('models.test.modelLabel', { model: result.model })}
              {result.baseUrl ? ` · ${result.baseUrl}` : ''}
              {result.provider ? ` · ${result.provider}` : ''}
            </Typography>
            <Divider sx={{ mb: 2 }} />
            <AttemptBlock title={sdkTitle} attempt={result.sdk} />
            <AttemptBlock title={t('models.test.axios')} attempt={result.axios} />
          </>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onRetry} disabled={loading}>
          {t('models.test.runAgain')}
        </Button>
        <Button onClick={onClose} variant="contained">
          {t('common.close')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ModelTestDialog;
