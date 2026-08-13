"use client";

import {
  AssignmentRounded,
  BoltRounded,
  ChatBubbleOutlineRounded,
  MemoryRounded,
} from '@mui/icons-material';
import {
  Avatar,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import Link from 'next/link';

import { useI18n } from '@/frontend/contexts/I18nContext';
import type { PersonaSummary } from '@/frontend/services/personas/summary';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';

import { personaCapabilities } from './personaCapabilities';

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusColor(
  status: PersonaSummary['status'],
): 'success' | 'warning' | 'error' | 'info' {
  if (status === 'working') return 'success';
  if (status === 'waiting-for-you') return 'warning';
  if (status === 'needs-attention') return 'error';
  return 'info';
}

export default function PersonaSummaryCard({
  summary,
  busy,
  onTalk,
}: {
  summary: PersonaSummary;
  busy: boolean;
  onTalk: (persona: Pick<PersonaSummary, 'id' | 'name'>) => Promise<void>;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const capabilities = personaCapabilities(summary);

  return (
    <Card
      variant="outlined"
      sx={{
        borderRadius: 4,
        overflow: 'visible',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 290,
      }}
    >
      <CardContent sx={{ flex: 1 }}>
        <Stack direction="row" spacing={2} alignItems="flex-start">
          <Avatar
            src={summary.presentation?.avatarUrl}
            alt={summary.name}
            sx={{
              width: 58,
              height: 58,
              bgcolor: alpha(theme.palette.primary.main, 0.18),
              color: 'primary.main',
              fontWeight: 800,
            }}
          >
            {summary.name.slice(0, 2).toUpperCase()}
          </Avatar>
          <Box minWidth={0} flex={1}>
            <Typography variant="h5" fontWeight={760} noWrap>{summary.name}</Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {t('personas.role', {
                role: summary.role.name,
                version: summary.role.version,
              })}
            </Typography>
          </Box>
          <Chip
            size="small"
            color={statusColor(summary.status)}
            label={t(`personas.status.${summary.status}`)}
          />
        </Stack>
        <Typography
          color="text.secondary"
          sx={{
            my: 2,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            minHeight: 48,
          }}
        >
          {summary.mission}
        </Typography>
        <Stack spacing={1.25}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <BoltRounded fontSize="small" color={summary.currentWork ? 'primary' : 'disabled'} />
            <Typography variant="body2" fontWeight={650} noWrap>
              {summary.currentWork
                ? summary.currentWork.summary
                  ?? `${humanize(summary.currentWork.kind)} · ${humanize(summary.currentWork.status)}`
                : t('personas.noActivity')}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip
              size="small"
              icon={<AssignmentRounded />}
              label={t('personas.queue', { count: summary.queuedCount })}
            />
            <Chip
              size="small"
              icon={<MemoryRounded />}
              label={t('personas.setup.memoriesCount', {
                count: summary.setupCounts.memories,
              })}
            />
          </Stack>
        </Stack>
      </CardContent>
      <Divider />
      <CardActions sx={{ px: 2, py: 1.5 }}>
        {capabilities.open && (
          <Button
            component={Link}
            href={withWorkspaceUrl(`/personas/${encodeURIComponent(summary.id)}?area=overview`)}
            size="small"
          >
            {t('personas.openDesk')}
          </Button>
        )}
        {capabilities.talk && (
          <Button
            size="small"
            startIcon={<ChatBubbleOutlineRounded />}
            onClick={() => void onTalk(summary)}
            disabled={busy}
          >
            {t('personas.chat')}
          </Button>
        )}
        {capabilities.assign && (
          <Button
            component={Link}
            href={withWorkspaceUrl(`/personas/${encodeURIComponent(summary.id)}?area=tasks`)}
            size="small"
          >
            {t('personas.assign')}
          </Button>
        )}
      </CardActions>
    </Card>
  );
}
