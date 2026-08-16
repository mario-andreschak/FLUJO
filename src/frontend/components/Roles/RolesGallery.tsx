'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AddRounded, RefreshRounded } from '@mui/icons-material';
import { Alert, Box, Button, Checkbox, FormControlLabel, Stack, Typography } from '@mui/material';
import CardPickerGrid from '@/frontend/components/shared/CardPickerGrid';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { RolesApiError, rolesService } from '@/frontend/services/roles';
import type { PublicRole } from '@/shared/types/enduringAgent';
import RoleCard from './RoleCard';

export default function RolesGallery() {
  const { t } = useI18n();
  const [roles, setRoles] = useState<PublicRole[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoles((await rolesService.list(includeArchived)).roles);
    } catch (caught) {
      setError(caught instanceof RolesApiError ? caught.message : t('roles.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [includeArchived, t]);

  useEffect(() => { void load(); }, [load]);

  const items = useMemo(() => roles.map((role) => ({
    key: role.id,
    label: role.name,
    searchText: `${role.name} ${role.prompt}`,
    content: <RoleCard role={role} />,
  })), [roles]);

  return (
    <Box component="main" sx={{ p: { xs: 2, md: 4 }, maxWidth: 1200, mx: 'auto' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={2} sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h4" component="h1">{t('roles.title')}</Typography>
          <Typography color="text.secondary">{t('roles.description')}</Typography>
        </Box>
        <Stack direction="row" gap={1} alignItems="center">
          <Button startIcon={<RefreshRounded />} onClick={() => void load()} disabled={loading}>
            {t('roles.refresh')}
          </Button>
          <Button component={Link} href="/roles/new" variant="contained" startIcon={<AddRounded />}>
            {t('roles.new')}
          </Button>
        </Stack>
      </Stack>
      <FormControlLabel
        sx={{ mb: 2 }}
        control={<Checkbox checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />}
        label={t('roles.includeArchived')}
      />
      {error && <Alert severity="error" action={<Button color="inherit" onClick={() => void load()}>{t('roles.retry')}</Button>}>{error}</Alert>}
      <CardPickerGrid
        searchable
        searchPlaceholder={t('roles.search')}
        isLoading={loading}
        error={error ? '' : null}
        loadingMessage={t('roles.loading')}
        emptyMessage={t('roles.empty')}
        items={items}
      />
    </Box>
  );
}
