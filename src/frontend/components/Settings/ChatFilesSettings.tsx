'use client';

import { useEffect, useState } from 'react';
import { Box, Button, Stack, TextField, Typography } from '@mui/material';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { httpIntakeServer } from '@/frontend/components/Chat/attachmentIntake';
import {
  CHAT_ATTACHMENT_BOUNDS,
  CHAT_ATTACHMENT_DEFAULTS,
  FALLBACK_CHAT_ATTACHMENT_LIMITS,
  normalizeChatAttachmentSettings,
  type ChatAttachmentSettings,
} from '@/shared/chatAttachments/limits';

const MiB = 1024 * 1024;
type Field = keyof ChatAttachmentSettings;

/** Limits for files added to a chat (#1224): each has a default that needs no change. */
export default function ChatFilesSettings() {
  const { settings, updateSettings } = useStorage();
  const { t, formatNumber } = useI18n();
  const saved = settings.chatAttachments ?? {};
  const [machine, setMachine] = useState({
    defaultMaxFileBytes: FALLBACK_CHAT_ATTACHMENT_LIMITS.maxFileBytes,
    maxInlineBytes: FALLBACK_CHAT_ATTACHMENT_LIMITS.maxInlineBytes,
  });
  const [drafts, setDrafts] = useState<Partial<Record<Field, string>>>({});

  useEffect(() => {
    let cancelled = false;
    void httpIntakeServer.machineDefaults().then(defaults => {
      if (!cancelled && defaults) setMachine(defaults);
    });
    return () => { cancelled = true; };
  }, []);

  const save = (next: ChatAttachmentSettings) => {
    const normalized = normalizeChatAttachmentSettings(next);
    void updateSettings({ ...settings, chatAttachments: normalized });
  };

  const commit = (field: Field) => {
    const draft = drafts[field];
    if (draft === undefined) return;
    setDrafts(current => ({ ...current, [field]: undefined }));
    const rest = { ...saved };
    delete rest[field];
    save(draft.trim() ? { ...rest, [field]: Number(draft) } : rest);
  };

  const field = (name: Field, label: string, help: string, bounds: { min: number; max: number }) => (
    <TextField
      key={name}
      type="number"
      size="small"
      label={label}
      value={drafts[name] ?? (saved[name] !== undefined ? String(saved[name]) : '')}
      placeholder={t('settings.chatFiles.defaultPlaceholder')}
      onChange={event => setDrafts(current => ({ ...current, [name]: event.target.value }))}
      onBlur={() => commit(name)}
      onKeyDown={event => { if (event.key === 'Enter') commit(name); }}
      helperText={help}
      slotProps={{ htmlInput: { min: bounds.min, max: bounds.max, 'data-testid': `chat-files-${name}` } }}
      sx={{ maxWidth: 420 }}
    />
  );

  const defaultMegabytes = Math.round(machine.defaultMaxFileBytes / MiB);
  const inlineMegabytes = Math.max(1, Math.round(machine.maxInlineBytes / MiB));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="body2" color="text.secondary">{t('settings.chatFiles.intro')}</Typography>
      <Stack spacing={2.5}>
        {field(
          'maxFileMegabytes',
          t('settings.chatFiles.maxFile'),
          t('settings.chatFiles.maxFileHelp', { value: formatNumber(defaultMegabytes), inline: formatNumber(inlineMegabytes) }),
          CHAT_ATTACHMENT_BOUNDS.maxFileMegabytes,
        )}
        {field(
          'maxPages',
          t('settings.chatFiles.maxPages'),
          t('settings.chatFiles.maxPagesHelp', { value: formatNumber(CHAT_ATTACHMENT_DEFAULTS.maxPages) }),
          CHAT_ATTACHMENT_BOUNDS.maxPages,
        )}
        {field(
          'maxTextCharacters',
          t('settings.chatFiles.maxText'),
          t('settings.chatFiles.maxTextHelp', { value: formatNumber(CHAT_ATTACHMENT_DEFAULTS.maxTextCharacters) }),
          CHAT_ATTACHMENT_BOUNDS.maxTextCharacters,
        )}
      </Stack>
      <Box>
        <Button variant="outlined" size="small" onClick={() => { setDrafts({}); save({}); }}>
          {t('settings.chatFiles.reset')}
        </Button>
      </Box>
    </Box>
  );
}
