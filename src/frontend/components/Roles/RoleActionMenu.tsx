'use client';

import { MouseEvent, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreVertRounded } from '@mui/icons-material';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Menu, MenuItem, Snackbar, Typography } from '@mui/material';
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
  const router = useRouter();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);

  const execute = async (task: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setAnchor(null);
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof RolesApiError ? caught.message : t('roles.saveFailed'));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const duplicate = () => execute(async () => {
    const copy = await rolesService.duplicate(role.id);
    router.push(`/roles/${encodeURIComponent(copy.id)}`);
  });

  const remove = () => execute(async () => {
    await rolesService.remove(role.id, role.currentVersionId);
    setDeleteOpen(false);
    onDeleted();
  });

  return (
    <>
      <IconButton ref={actionsButton} aria-label={t('roles.actions')} onClick={(event: MouseEvent<HTMLElement>) => setAnchor(event.currentTarget)}>
        <MoreVertRounded />
      </IconButton>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <MenuItem disabled={pending} onClick={() => void duplicate()}>{t('roles.duplicate')}</MenuItem>
        {role.archived
          ? <MenuItem disabled={pending} onClick={() => void execute(async () => onChanged(await rolesService.restore(role.id, { expectedCurrentVersionId: role.currentVersionId })))}>{t('roles.restore')}</MenuItem>
          : <MenuItem disabled={pending} onClick={() => void execute(async () => onChanged(await rolesService.archive(role.id, role.currentVersionId)))}>{t('roles.archive')}</MenuItem>}
        <MenuItem disabled={pending || !impact.hardDeleteAllowed} onClick={() => { setAnchor(null); setError(null); setDeleteOpen(true); }}>{t('roles.delete')}</MenuItem>
      </Menu>
      <Dialog open={deleteOpen} fullWidth maxWidth="sm" aria-labelledby="role-delete-title" disableRestoreFocus
        onClose={() => { if (!inFlight.current) setDeleteOpen(false); }}
        slotProps={{ transition: { onExited: () => actionsButton.current?.focus() } }}>
        <DialogTitle id="role-delete-title">{t('roles.delete')}</DialogTitle>
        <DialogContent><Typography>{t('roles.deleteConfirm')}</Typography>{error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}</DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Button autoFocus disabled={pending} onClick={() => setDeleteOpen(false)}>{t('roles.cancel')}</Button>
          <Button color="error" variant="contained" disabled={pending || !impact.hardDeleteAllowed} onClick={() => void remove()}>{t('roles.delete')}</Button>
        </DialogActions>
      </Dialog>
      <Snackbar open={Boolean(error) && !deleteOpen} autoHideDuration={6000} onClose={() => setError(null)}>
        <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>
      </Snackbar>
    </>
  );
}
