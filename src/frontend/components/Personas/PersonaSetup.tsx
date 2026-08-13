"use client";

import { HubRounded } from '@mui/icons-material';
import {
  Box,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';

import { useI18n } from '@/frontend/contexts/I18nContext';
import type { PersonaDetail } from '@/frontend/services/personas';
import type { Persona } from '@/shared/types/enduringAgent';

export default function PersonaSetup({
  detail,
  children,
}: {
  detail: PersonaDetail;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const coreFlowRef = (
    detail.persona as Persona & { coreFlowRef?: string }
  ).coreFlowRef;
  const facts = [
    {
      label: t('personas.setup.role'),
      value: t('personas.role', {
        role: detail.roleVersion.name,
        version: detail.roleVersion.version,
      }),
    },
    {
      label: t('personas.setup.coreFlow'),
      value: coreFlowRef ?? t('personas.setup.notConfigured'),
    },
    {
      label: t('personas.setup.behaviors'),
      value: String(detail.behaviorBindings.length),
    },
    {
      label: t('personas.setup.apps'),
      value: String(detail.appGrants.length),
    },
    {
      label: t('personas.setup.memories'),
      value: String(detail.memoryItems.filter((item) => item.status !== 'forgotten').length),
    },
  ];

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 4 }}>
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ mb: 2.5 }}
        >
          <Box color="primary.main"><HubRounded /></Box>
          <Typography variant="h5" fontWeight={760}>{t('personas.setup.title')}</Typography>
        </Stack>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(2, minmax(0, 1fr))',
              lg: 'repeat(5, minmax(0, 1fr))',
            },
            gap: 1.5,
          }}
        >
          {facts.map((fact) => (
            <Paper key={fact.label} variant="outlined" sx={{ p: 2, borderRadius: 2.5 }}>
              <Typography variant="overline" color="text.secondary">{fact.label}</Typography>
              <Typography fontWeight={740} sx={{ overflowWrap: 'anywhere' }}>
                {fact.value}
              </Typography>
            </Paper>
          ))}
        </Box>
      </Paper>
      {children}
    </Stack>
  );
}
