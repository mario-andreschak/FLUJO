'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { EditRounded } from '@mui/icons-material';
import { Alert, Box, Button, Chip, CircularProgress, Divider, Stack, Typography } from '@mui/material';
import type { PublicRole, RoleImpactPreview } from '@/shared/types/enduringAgent';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { rolesService } from '@/frontend/services/roles';
import RoleActionMenu from './RoleActionMenu';
import RoleVersionHistory from './RoleVersionHistory';

export default function RoleDetail({ roleId }: { roleId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [role, setRole] = useState<PublicRole | null>(null);
  const [impact, setImpact] = useState<RoleImpactPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextRole, nextImpact] = await Promise.all([rolesService.get(roleId), rolesService.impact(roleId)]);
      setRole(nextRole);
      setImpact(nextImpact);
    } catch {
      setError(t('roles.loadFailed'));
    }
  }, [roleId, t]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <Alert severity="error" sx={{ m: 4 }}>{error}</Alert>;
  if (!role || !impact) return <Stack alignItems="center" sx={{ p: 6 }}><CircularProgress /></Stack>;

  return (
    <Box component="main" sx={{ p: { xs: 2, md: 4 }, maxWidth: 900, mx: 'auto' }}>
      <Button component={Link} href="/roles">{t('roles.back')}</Button>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={2} sx={{ mt: 2 }}>
        <Box>
          <Stack direction="row" gap={1} alignItems="center">
            <Typography variant="h4" component="h1">{role.name}</Typography>
            {role.archived && <Chip label={t('roles.archived')} />}
          </Stack>
          <Typography sx={{ mt: 2, whiteSpace: 'pre-wrap' }}>{role.prompt}</Typography>
        </Box>
        <Stack direction="row">
          {!role.archived && (
            <Button component={Link} href={`/roles/${encodeURIComponent(role.id)}/edit`} startIcon={<EditRounded />}>
              {t('roles.edit')}
            </Button>
          )}
          <RoleActionMenu
            role={role}
            impact={impact}
            onChanged={(next) => setRole(next)}
            onDeleted={() => router.push('/roles')}
          />
        </Stack>
      </Stack>
      <Divider sx={{ my: 3 }} />
      <Typography variant="h6">{t('roles.behaviors')}</Typography>
      <Typography color="text.secondary" sx={{ mt: 0.5 }}>
        {t('roles.behaviorsHelp')}
      </Typography>
      <Stack gap={1.5} sx={{ my: 1.5 }}>
        {role.behaviors.map((behavior) => (
          <Box
            key={behavior.key}
            sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }}
          >
            <Typography fontWeight={700}>{behavior.name}</Typography>
            {behavior.description && (
              <Typography color="text.secondary" sx={{ mt: 0.5 }}>
                {behavior.description}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
      <Typography variant="h6">{t('roles.suggestedApps')}</Typography>
      <Stack direction="row" gap={1} flexWrap="wrap" sx={{ my: 1.5 }}>
        {role.suggestedApps.length === 0
          ? <Typography color="text.secondary">{t('roles.noApps')}</Typography>
          : role.suggestedApps.map((app) => (
            <Chip key={app.mcpServerName} label={app.mcpServerName} color={app.status === 'available' ? 'default' : 'warning'} />
          ))}
      </Stack>
      <Typography variant="h6" sx={{ mt: 3 }}>{t('roles.personasUsage')}</Typography>
      <Alert severity="info" sx={{ my: 1.5 }}>
        {impact.personaCount === 0
          ? t('roles.personasNone')
          : t('roles.personasUnchanged', { count: impact.personaCount })}
      </Alert>
      <RoleVersionHistory role={role} onChanged={(next) => { setRole(next); void load(); }} />
    </Box>
  );
}
