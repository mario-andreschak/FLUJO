"use client";

import {
  AppsRounded,
  ArrowBackRounded,
  AutoStoriesRounded,
  BoltRounded,
  ChatBubbleOutlineRounded,
  HubRounded,
  MemoryRounded,
  RefreshRounded,
  SettingsRounded,
  WorkOutlineRounded,
} from '@mui/icons-material';
import {
  Avatar,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';

import { useI18n } from '@/frontend/contexts/I18nContext';
import type { PersonaDetail } from '@/frontend/services/personas';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type { Persona } from '@/shared/types/enduringAgent';

import {
  normalizePersonaArea,
  type PersonaArea,
  type PersonaAreaSubsection,
} from './personaTypes';

type PersonaNavigationArea = PersonaArea | 'behaviors' | 'apps';

const PERSONA_NAVIGATION_AREAS = [
  'overview',
  'setup',
  'behaviors',
  'apps',
  'memory',
  'conversations',
  'tasks',
  'settings',
] as const satisfies readonly PersonaNavigationArea[];

const AREA_ICON = {
  overview: BoltRounded,
  setup: HubRounded,
  behaviors: AutoStoriesRounded,
  apps: AppsRounded,
  memory: MemoryRounded,
  conversations: ChatBubbleOutlineRounded,
  tasks: WorkOutlineRounded,
  settings: SettingsRounded,
} satisfies Record<PersonaNavigationArea, typeof BoltRounded>;

function lifecycleColor(
  state: Persona['lifecycleState'],
): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (state === 'idle') return 'success';
  if (state === 'busy' || state === 'waiting') return 'info';
  if (state === 'error') return 'error';
  if (state === 'sleeping') return 'warning';
  return 'default';
}

export default function PersonaDetailShell({
  detail,
  busy,
  refresh,
  startConversation,
  renderArea,
}: {
  detail: PersonaDetail;
  busy: boolean;
  refresh: () => Promise<void>;
  startConversation: () => Promise<void>;
  renderArea: (area: PersonaArea, subsection: PersonaAreaSubsection) => ReactNode;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const theme = useTheme();
  const [area, setArea] = useState<PersonaArea>('overview');
  const [subsection, setSubsection] = useState<PersonaAreaSubsection>(null);
  const selectedNavigationArea: PersonaNavigationArea = area === 'setup'
    && (subsection === 'behaviors' || subsection === 'apps')
    ? subsection
    : area;
  const lifecycleLabel = detail.persona.lifecycleState === 'busy'
    ? t('personas.status.working')
    : detail.persona.lifecycleState === 'waiting'
      ? t('personas.status.waiting-for-you')
      : detail.persona.lifecycleState === 'error' || detail.persona.lifecycleState === 'disabled'
        ? t('personas.status.needs-attention')
        : t('personas.status.up-next');

  useEffect(() => {
    const syncFromLocation = () => {
      if (typeof window === 'undefined') return;
      const params = new URLSearchParams(window.location.search);
      const normalized = normalizePersonaArea(params.get('area'));
      let nextSubsection = normalized.subsection;
      const requestedSection = params.get('section');
      if (
        normalized.area === 'setup'
        && (requestedSection === 'behaviors' || requestedSection === 'apps')
      ) {
        nextSubsection = requestedSection;
      } else if (normalized.area === 'settings' && requestedSection === 'history') {
        nextSubsection = 'history';
      }
      setArea(normalized.area);
      setSubsection(nextSubsection);

      if (normalized.shouldCanonicalize) {
        const sectionQuery = nextSubsection ? `&section=${nextSubsection}` : '';
        router.replace(withWorkspaceUrl(
          `/personas/${encodeURIComponent(detail.persona.id)}`
          + `?area=${normalized.area}${sectionQuery}`,
        ));
      }
    };
    syncFromLocation();
    window.addEventListener('popstate', syncFromLocation);
    return () => window.removeEventListener('popstate', syncFromLocation);
  }, [detail.persona.id, router]);

  const selectArea = (next: PersonaNavigationArea) => {
    const nextArea: PersonaArea = next === 'behaviors' || next === 'apps'
      ? 'setup'
      : next;
    const nextSubsection: PersonaAreaSubsection = next === 'behaviors' || next === 'apps'
      ? next
      : null;
    const sectionQuery = nextSubsection ? `&section=${nextSubsection}` : '';
    setArea(nextArea);
    setSubsection(nextSubsection);
    router.replace(withWorkspaceUrl(
      `/personas/${encodeURIComponent(detail.persona.id)}`
      + `?area=${nextArea}${sectionQuery}`,
    ));
  };

  return (
    <Stack spacing={2.5}>
      <Button
        component={Link}
        href={withWorkspaceUrl('/personas')}
        startIcon={<ArrowBackRounded />}
        sx={{ alignSelf: 'flex-start' }}
      >
        {t('personas.back')}
      </Button>
      <Paper
        variant="outlined"
        sx={{
          p: { xs: 2, md: 3 },
          borderRadius: 4,
          background: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.12)}, ${alpha(theme.palette.background.paper, 0.92)} 48%, ${alpha(theme.palette.secondary.main, 0.08)})`,
        }}
      >
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2.5}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
        >
          <Avatar
            src={detail.persona.presentation?.avatarUrl}
            alt={detail.persona.name}
            sx={{
              width: 76,
              height: 76,
              bgcolor: alpha(theme.palette.primary.main, 0.2),
              color: 'primary.main',
              fontSize: 26,
              fontWeight: 800,
            }}
          >
            {detail.persona.name.slice(0, 2).toUpperCase()}
          </Avatar>
          <Box flex={1} minWidth={0}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography
                variant="h3"
                component="h1"
                fontWeight={790}
                letterSpacing="-0.045em"
              >
                {detail.persona.name}
              </Typography>
              <Chip
                color={lifecycleColor(detail.persona.lifecycleState)}
                label={lifecycleLabel}
                aria-live="polite"
              />
            </Stack>
            <Typography color="text.secondary" fontWeight={650}>
              {t('personas.role', {
                role: detail.roleVersion.name,
                version: detail.roleVersion.version,
              })}
            </Typography>
            <Typography sx={{ mt: 0.75, maxWidth: 900 }}>{detail.persona.mission}</Typography>
          </Box>
          <Button
            variant="contained"
            startIcon={<ChatBubbleOutlineRounded />}
            onClick={() => void startConversation()}
            disabled={
              busy
              || detail.persona.lifecycleState === 'disabled'
              || detail.persona.lifecycleState === 'error'
            }
          >
            {t('personas.chat')}
          </Button>
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
        <Tabs
          value={selectedNavigationArea}
          onChange={(_event, value: PersonaNavigationArea) => selectArea(value)}
          variant="scrollable"
          scrollButtons="auto"
          aria-label={t('personas.title')}
        >
          {PERSONA_NAVIGATION_AREAS.map((key) => {
            const Icon = AREA_ICON[key];
            return (
              <Tab
                key={key}
                value={key}
                icon={<Icon fontSize="small" />}
                iconPosition="start"
                label={t(`personas.area.${key}`)}
              />
            );
          })}
        </Tabs>
      </Paper>
      {renderArea(area, subsection)}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          startIcon={<RefreshRounded />}
          onClick={() => void refresh()}
          disabled={busy}
        >
          {t('personas.refresh')}
        </Button>
      </Box>
    </Stack>
  );
}
