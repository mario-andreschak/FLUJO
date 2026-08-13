'use client';

import { useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Button, CircularProgress, List, ListItem, ListItemText, Stack, Typography,
} from '@mui/material';
import { ExpandMoreRounded } from '@mui/icons-material';
import type { PublicRole, PublicRoleVersion } from '@/shared/types/enduringAgent';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { RolesApiError, rolesService } from '@/frontend/services/roles';

export default function RoleVersionHistory({ role, onChanged }: { role: PublicRole; onChanged: (role: PublicRole) => void }) {
  const { t } = useI18n();
  const [versions, setVersions] = useState<PublicRoleVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (loaded) return;
    setLoading(true);
    try {
      setVersions((await rolesService.versions(role.id)).versions);
      setLoaded(true);
    } catch {
      setError(t('roles.historyLoadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const rollback = async (sourceVersionId: string) => {
    if (!window.confirm(t('roles.rollbackConfirm'))) return;
    setLoading(true);
    setError(null);
    try {
      const next = await rolesService.rollback(role.id, {
        expectedCurrentVersionId: role.currentVersionId,
        sourceVersionId,
      });
      onChanged(next);
      setVersions((await rolesService.versions(role.id)).versions);
      setLoaded(true);
    } catch (caught) {
      setError(caught instanceof RolesApiError ? caught.message : t('roles.saveFailed'));
    } finally {
      setLoading(false);
    }
  };


  return (
    <Accordion onChange={(_, expanded) => { if (expanded) void load(); }}>
      <AccordionSummary expandIcon={<ExpandMoreRounded />}>
        <Typography>{t('roles.history')}</Typography>
      </AccordionSummary>
      <AccordionDetails>
        {loading && <Stack alignItems="center"><CircularProgress size={24} /></Stack>}
        {error && <Alert severity="error">{error}</Alert>}
        <List>
          {versions.map((version) => (
            <ListItem
              key={version.id}
              divider
              secondaryAction={!version.current && !role.archived
                ? <Button disabled={loading} onClick={() => void rollback(version.id)}>{t('roles.rollback')}</Button>
                : undefined}
            >
              <ListItemText
                primary={t('roles.version', { version: version.version })}
                secondary={version.prompt}
              />
            </ListItem>
          ))}
        </List>
      </AccordionDetails>
    </Accordion>
  );
}
