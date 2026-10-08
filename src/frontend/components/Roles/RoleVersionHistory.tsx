'use client';

import { localizeRoleBehavior } from '@/frontend/utils/roleBehaviorLabels';

import { useRef, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItem, ListItemText, Stack, Typography,
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
  const [selectedVersion, setSelectedVersion] = useState<PublicRoleVersion | null>(null);
  const rollbackTrigger = useRef<HTMLButtonElement | null>(null);
  const historyTrigger = useRef<HTMLDivElement | null>(null);
  const rollbackPending = useRef(false);

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
    if (rollbackPending.current) return;
    rollbackPending.current = true;
    setLoading(true);
    setError(null);
    try {
      const next = await rolesService.rollback(role.id, {
        expectedCurrentVersionId: role.currentVersionId,
        sourceVersionId,
      });
      onChanged(next);
      setSelectedVersion(null);
      setVersions((await rolesService.versions(role.id)).versions);
      setLoaded(true);
    } catch (caught) {
      setError(caught instanceof RolesApiError ? caught.message : t('roles.saveFailed'));
    } finally {
      rollbackPending.current = false;
      setLoading(false);
    }
  };


  return (
    <Accordion slots={{ heading: 'h2' }} onChange={(_, expanded) => { if (expanded) void load(); }}>
      <AccordionSummary ref={historyTrigger} expandIcon={<ExpandMoreRounded />}>
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
                ? <Button disabled={loading} onClick={(event) => { rollbackTrigger.current = event.currentTarget; setError(null); setSelectedVersion(version); }}>{t('roles.rollback')}</Button>
                : undefined}
            >
              <ListItemText
                primary={t('roles.version', { version: version.version })}
                secondary={(
                  <Stack component="span" gap={0.5} sx={{ mt: 0.5 }}>
                    <Typography component="span" variant="body2" color="text.secondary">
                      {version.prompt}
                    </Typography>
                    <Typography component="span" variant="caption" color="text.secondary">
                      {t('roles.versionBehaviors', {
                        behaviors: version.behaviors.map((behavior) => localizeRoleBehavior(behavior, t).name).join(', '),
                      })}
                    </Typography>
                  </Stack>
                )}
                secondaryTypographyProps={{ component: 'div' }}
              />
            </ListItem>
          ))}
        </List>
        <Dialog open={Boolean(selectedVersion)} fullWidth maxWidth="sm" aria-labelledby="role-rollback-title" disableRestoreFocus
          onClose={() => { if (!rollbackPending.current) setSelectedVersion(null); }}
          slotProps={{ transition: { onExited: () => {
            const trigger = rollbackTrigger.current;
            (trigger?.isConnected && !trigger.disabled ? trigger : historyTrigger.current)?.focus();
          } } }}>
          <DialogTitle id="role-rollback-title">{t('roles.rollback')} — {t('roles.version', { version: selectedVersion?.version ?? '' })}</DialogTitle>
          <DialogContent><Typography>{t('roles.rollbackConfirm')}</Typography>{error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}</DialogContent>
          <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
            <Button autoFocus disabled={loading} onClick={() => setSelectedVersion(null)}>{t('roles.cancel')}</Button>
            <Button variant="contained" disabled={loading || role.archived} onClick={() => { if (selectedVersion) void rollback(selectedVersion.id); }}>{t('roles.rollback')}</Button>
          </DialogActions>
        </Dialog>
      </AccordionDetails>
    </Accordion>
  );
}
