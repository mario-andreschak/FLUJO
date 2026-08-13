"use client";

import { AutoStoriesRounded, LockRounded } from '@mui/icons-material';
import { Box, Card, CardActionArea, CardContent, Chip, Stack, Typography, alpha } from '@mui/material';
import type { RoleVersion } from '@/shared/types/enduringAgent';

interface RoleVersionCardProps {
  role: RoleVersion;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: (roleVersionId: string) => void;
}

/** A compact, domain-specific Role Version card used by Persona creation. */
export default function RoleVersionCard({
  role,
  selected = false,
  disabled = false,
  onSelect,
}: RoleVersionCardProps) {
  return (
    <Card
      variant="outlined"
      aria-disabled={disabled || undefined}
      sx={(theme) => ({
        height: '100%',
        borderRadius: 3,
        opacity: disabled ? 0.58 : 1,
        borderColor: selected ? 'primary.main' : 'divider',
        boxShadow: selected ? `0 0 0 3px ${alpha(theme.palette.primary.main, 0.13)}` : undefined,
      })}
    >
      <CardActionArea
        component={onSelect ? 'button' : 'div'}
        disabled={disabled}
        tabIndex={onSelect ? -1 : undefined}
        onClick={() => !disabled && onSelect?.(role.id)}
        sx={{ height: '100%', alignItems: 'stretch' }}
      >
        <CardContent>
          <Stack direction="row" spacing={1.25} alignItems="flex-start">
            <Box
              aria-hidden="true"
              sx={(theme) => ({
                width: 44,
                height: 44,
                flexShrink: 0,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 2.5,
                color: 'primary.main',
                bgcolor: alpha(theme.palette.primary.main, 0.1),
              })}
            >
              <AutoStoriesRounded />
            </Box>
            <Box minWidth={0} flex={1}>
              <Typography variant="h6" noWrap title={role.name}>{role.name}</Typography>
              <Stack direction="row" spacing={0.75} sx={{ mt: 0.5 }}>
                <Chip size="small" label={`v${role.version}`} />
                <Chip size="small" icon={<LockRounded />} label="Immutable" variant="outlined" />
              </Stack>
            </Box>
          </Stack>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
          >
            {role.mission}
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.25 }}>
            {role.behaviorSlots.length} behavior {role.behaviorSlots.length === 1 ? 'slot' : 'slots'}
          </Typography>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}
