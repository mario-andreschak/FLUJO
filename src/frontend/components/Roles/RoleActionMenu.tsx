'use client';

import { MouseEvent, useState } from 'react';
import { MoreVertRounded } from '@mui/icons-material';
import { Alert, IconButton, Menu, MenuItem, Snackbar } from '@mui/material';
import type { PublicRole, RoleImpactPreview } from '@/shared/types/enduringAgent';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { RolesApiError, rolesService } from '@/frontend/services/roles';

export default function RoleActionMenu({
  role,
  impact,
  onChanged,
  onDeleted,
}: {
  role: PublicRole;
  impact: RoleImpactPreview;
  onChanged: (role: PublicRole) => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = async (task: () => Promise<void>) => {
    setAnchor(null);
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof RolesApiError ? caught.message : t('roles.saveFailed'));
    } finally {
      setPending(false);
    }
  };

  const duplicate = () => execute(async () => {
    const copy = await rolesService.duplicate(role.id);
    window.location.assign(`/roles/${encodeURIComponent(copy.id)}`);
  });

  const remove = () => execute(async () => {
    if (!window.confirm(t('roles.deleteConfirm'))) return;
    await rolesService.remove(role.id, role.currentVersionId);
    onDeleted();
  });

  return (
    <>
      <IconButton aria-label={t('roles.actions')} onClick={(event: MouseEvent<HTMLElement>) => setAnchor(event.currentTarget)}>
        <MoreVertRounded />
      </IconButton>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <MenuItem disabled={pending} onClick={() => void duplicate()}>{t('roles.duplicate')}</MenuItem>
        {role.archived
          ? <MenuItem disabled={pending} onClick={() => void execute(async () => onChanged(await rolesService.restore(role.id, { expectedCurrentVersionId: role.currentVersionId })))}>{t('roles.restore')}</MenuItem>
          : <MenuItem disabled={pending} onClick={() => void execute(async () => onChanged(await rolesService.archive(role.id, role.currentVersionId)))}>{t('roles.archive')}</MenuItem>}
        <MenuItem disabled={pending || !impact.hardDeleteAllowed} onClick={() => void remove()}>{t('roles.delete')}</MenuItem>
      </Menu>
      <Snackbar open={Boolean(error)} autoHideDuration={6000} onClose={() => setError(null)}>
        <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>
      </Snackbar>
    </>
  );
}
