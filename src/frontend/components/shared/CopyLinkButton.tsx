"use client";

import React, { useCallback, useState } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import LinkRoundedIcon from '@mui/icons-material/LinkRounded';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { magicLinkUrl, type MagicLinkTarget } from '@/frontend/utils/magicLink';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/shared/CopyLinkButton');

export interface CopyLinkButtonProps {
  target: MagicLinkTarget;
  size?: 'small' | 'medium';
  className?: string;
  sx?: SxProps<Theme>;
  /**
   * Optional override for the idle tooltip/aria-label (#398). Placements that
   * are not next to the entity they link to (the navbar) need a more specific
   * accessible name than the generic "Copy link". The transient
   * copied/failed feedback labels are unchanged.
   */
  label?: string;
}

/** Copies text via the Clipboard API, falling back to a hidden textarea +
 * `document.execCommand('copy')` on non-secure origins (http, older Edge)
 * where `navigator.clipboard` is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      log.warn('navigator.clipboard.writeText failed, falling back', { error });
    }
  }

  if (typeof document === 'undefined') return false;

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const succeeded = document.execCommand('copy');
    document.body.removeChild(textarea);
    return succeeded;
  } catch (error) {
    log.error('Clipboard fallback failed', { error });
    return false;
  }
}

/**
 * Small "copy a shareable link to this entity" affordance (#374). Copies the
 * magic link built from `target` and briefly shows a "Copied"/"Failed"
 * tooltip. Ids only — never place secrets in `target.extra`.
 */
export default function CopyLinkButton({ target, size = 'small', className, sx, label: idleLabel }: CopyLinkButtonProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleClick = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
      const url = magicLinkUrl(target);
      const succeeded = await copyText(url);
      setStatus(succeeded ? 'copied' : 'failed');
      window.setTimeout(() => setStatus('idle'), 1500);
    },
    [target]
  );

  const label =
    status === 'copied'
      ? t('magicLink.copied')
      : status === 'failed'
        ? t('magicLink.copyFailed')
        : (idleLabel ?? t('magicLink.copy'));

  return (
    <Tooltip title={label} disableInteractive>
      <IconButton size={size} className={className} onClick={handleClick} aria-label={label} sx={sx}>
        <LinkRoundedIcon fontSize={size} />
      </IconButton>
    </Tooltip>
  );
}
