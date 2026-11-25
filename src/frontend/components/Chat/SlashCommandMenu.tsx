"use client";

import React, { useEffect, useRef } from 'react';
import { Alert, AlertTitle, Box, Paper, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { SlashCommandId, SlashCommandNotice, SlashCommandSpec } from './slashCommands';

export const SLASH_MENU_ID = 'chat-slash-command-menu';

export const slashOptionId = (id: SlashCommandId): string => `${SLASH_MENU_ID}-${id}`;

/**
 * The command list above the message box. The message box keeps focus; the
 * arrow keys move the highlighted entry, which it names as its active entry.
 */
export default function SlashCommandMenu({
  commands,
  activeIndex,
  emptyText,
  onHover,
  onChoose,
}: {
  commands: SlashCommandSpec[];
  activeIndex: number;
  /** Why nothing is listed, when the typed name is a command that does not fit this chat. */
  emptyText?: string;
  onHover: (index: number) => void;
  onChoose: (command: SlashCommandSpec) => void;
}) {
  const { t } = useI18n();
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <Paper
      elevation={8}
      data-testid="chat-slash-menu"
      sx={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        mb: 0.5,
        zIndex: 1500,
        maxHeight: 320,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        id={SLASH_MENU_ID}
        role="listbox"
        aria-label={t('chat.slash.menuLabel')}
        sx={{ overflowY: 'auto', flex: 1 }}
      >
        {commands.map((command, index) => (
          <Box
            key={command.id}
            ref={index === activeIndex ? activeRef : undefined}
            id={slashOptionId(command.id)}
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onChoose(command)}
            sx={{
              px: 1.5,
              py: 0.75,
              cursor: 'pointer',
              bgcolor: index === activeIndex ? 'action.selected' : 'transparent',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Typography component="div" sx={{ fontFamily: 'monospace', fontSize: 14 }}>
              /{command.name}
              {command.argsHint && (
                <Typography component="span" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 14 }}>
                  {' '}{t(command.argsHint)}
                </Typography>
              )}
            </Typography>
            <Typography variant="caption" color="text.secondary">{t(command.description)}</Typography>
          </Box>
        ))}
      </Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ px: 1.5, py: 0.75, borderTop: 1, borderColor: 'divider' }}
      >
        {commands.length === 0 ? (emptyText ?? t('chat.slash.noMatch')) : t('chat.slash.menuHint')}
      </Typography>
    </Paper>
  );
}

/** A command's short answer, shown above the message box until closed. */
export function SlashCommandNoticeBanner({
  notice,
  onClose,
}: {
  notice: SlashCommandNotice;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const lines = notice.lines ?? [];
  return (
    <Alert
      severity={notice.tone}
      role={notice.tone === 'error' ? 'alert' : 'status'}
      data-testid="chat-slash-notice"
      onClose={onClose}
      closeText={t('chat.slash.dismiss')}
      sx={{ mb: 1, maxHeight: 260, overflowY: 'auto' }}
    >
      <AlertTitle sx={{ mb: lines.length ? 0.5 : 0 }}>{notice.title}</AlertTitle>
      {lines.length === 1 && <Typography variant="body2">{lines[0]}</Typography>}
      {lines.length > 1 && (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {lines.map((line, index) => (
            <Typography key={index} component="li" variant="body2">{line}</Typography>
          ))}
        </Box>
      )}
    </Alert>
  );
}
