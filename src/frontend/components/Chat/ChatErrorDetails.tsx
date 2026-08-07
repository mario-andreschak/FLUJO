'use client';

import React, { useState } from 'react';
import { Box, Typography, Chip, Stack, Link, Snackbar } from '@mui/material';
import type { NormalizedChatError } from '@/shared/types/execution/errors';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';
import type { StatisticsErrorClass } from '@/shared/types/statistics';

const ERROR_CLASS_KEYS: Record<StatisticsErrorClass, TranslationKey> = {
  authentication: 'chat.page.errorClass.authentication',
  authorization: 'chat.page.errorClass.authorization',
  cancelled: 'chat.page.errorClass.cancelled',
  configuration: 'chat.page.errorClass.configuration',
  context_limit: 'chat.page.errorClass.context_limit',
  network: 'chat.page.errorClass.network',
  provider: 'chat.page.errorClass.provider',
  rate_limit: 'chat.page.errorClass.rate_limit',
  timeout: 'chat.page.errorClass.timeout',
  validation: 'chat.page.errorClass.validation',
  unknown: 'chat.page.errorClass.unknown',
};

/**
 * Issue #383 ("Chat Error Code"): the single presentational component shared
 * by the transient error Alert and the persistent "conversation ended with an
 * error" banner in `Chat/index.tsx`, so the two cannot render different
 * information for the same failure.
 *
 * Renders: the message, a chip row for code/HTTP status/error class/retry
 * hint (whichever are present), and a collapsed "Details" expander with the
 * already-REDACTED provider body (never the raw one — redaction happens
 * backend-side in `normalizeError.ts` before this ever reaches the client).
 */
export interface ChatErrorDetailsProps {
  error: NormalizedChatError | null | undefined;
  /** Plain-string fallback message, used when `error` is absent (older event
   *  shape without the normalized payload). */
  fallbackMessage?: string;
  /** Compact mode drops the "Details" expander/copy affordances — used
   *  inside the transient inline alert where space is tight. */
  compact?: boolean;
}

export default function ChatErrorDetails({ error, fallbackMessage, compact }: ChatErrorDetailsProps) {
  const { t } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const message = error?.message || fallbackMessage || t('chat.page.endedError');
  const hasChips = !!(error && (error.code || error.httpStatus || error.errorClass || error.retryAfter));

  const handleCopy = async () => {
    try {
      const payload = JSON.stringify(error ?? { message }, null, 2);
      await navigator.clipboard.writeText(payload);
      setCopied(true);
    } catch {
      // Clipboard access can be denied (permissions/insecure context); the
      // Details expander below still lets the user select+copy manually.
    }
  };

  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" component="span" sx={{ wordBreak: 'break-word' }}>
        {message}
      </Typography>
      {hasChips && (
        <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ mt: 0.5 }}>
          {error?.code && (
            <Chip size="small" variant="outlined" label={t('chat.page.errorCode', { code: error.code })} />
          )}
          {error?.httpStatus !== undefined && (
            <Chip size="small" variant="outlined" label={t('chat.page.errorStatus', { status: error.httpStatus })} />
          )}
          {error?.errorClass && (
            <Chip
              size="small"
              variant="outlined"
              label={t(ERROR_CLASS_KEYS[error.errorClass])}
            />
          )}
          {error?.retryAfter && (
            <Chip size="small" variant="outlined" label={t('chat.page.errorRetryAfter', { seconds: error.retryAfter })} />
          )}
        </Stack>
      )}
      {!compact && error && (error.details || hasChips) && (
        <Box sx={{ mt: 0.5 }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Link
              component="button"
              type="button"
              variant="caption"
              underline="hover"
              onClick={() => setDetailsOpen(v => !v)}
              sx={{ color: 'inherit' }}
            >
              {t('chat.page.errorDetails')} {detailsOpen ? '▾' : '▸'}
            </Link>
            <Link
              component="button"
              type="button"
              variant="caption"
              underline="hover"
              onClick={handleCopy}
              sx={{ color: 'inherit' }}
            >
              {t('chat.page.errorCopy')}
            </Link>
          </Stack>
          {detailsOpen && error.details && (
            <Box
              component="pre"
              sx={{
                mt: 0.5,
                p: 1,
                maxHeight: 240,
                overflow: 'auto',
                fontSize: '0.7rem',
                bgcolor: 'action.hover',
                borderRadius: 1,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {JSON.stringify(error.details, null, 2)}
            </Box>
          )}
        </Box>
      )}
      <Snackbar
        open={copied}
        autoHideDuration={2000}
        onClose={() => setCopied(false)}
        message={t('chat.page.errorCopied')}
      />
    </Box>
  );
}
