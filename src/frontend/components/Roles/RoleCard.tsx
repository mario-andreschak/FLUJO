'use client';

import Link from 'next/link';
import { Card, CardActionArea, CardContent, Chip, Stack, Typography } from '@mui/material';
import type { PublicRole } from '@/shared/types/enduringAgent';
import { useI18n } from '@/frontend/contexts/I18nContext';

export default function RoleCard({ role }: { role: PublicRole }) {
  const { t } = useI18n();
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardActionArea component={Link} href={`/roles/${encodeURIComponent(role.id)}`} sx={{ height: '100%' }}>
        <CardContent>
          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
            <Typography variant="h6" component="h2">{role.name}</Typography>
            {role.archived && <Chip size="small" label={t('roles.archived')} />}
          </Stack>
          <Typography color="text.secondary" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>
            {role.prompt}
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            sx={{ mt: 2 }}
            label={t('roles.apps.count', { count: role.suggestedApps.length })}
          />
        </CardContent>
      </CardActionArea>
    </Card>
  );
}
