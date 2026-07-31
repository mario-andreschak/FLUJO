"use client";

import { Box, Stack, Typography, useTheme } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { ElementType, ReactNode } from 'react';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: string;
  icon?: ElementType;
  leading?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  maxWidth?: number | string;
}

/**
 * Shared page chrome for FLUJO's resource and workspace screens.
 * It keeps hierarchy, spacing, responsive action placement, and the ambient
 * product signature consistent without imposing a content layout.
 */
export default function PageHeader({
  title,
  description,
  eyebrow,
  icon: Icon,
  leading,
  badge,
  actions,
  compact = false,
  maxWidth = 1440,
}: PageHeaderProps) {
  const theme = useTheme();

  return (
    <Box
      component="header"
      sx={{
        position: 'relative',
        overflow: 'hidden',
        borderBottom: 1,
        borderColor: 'divider',
        background: `linear-gradient(110deg, ${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.09 : 0.055)}, transparent 38%, ${alpha(theme.palette.secondary.main, 0.045)})`,
        '&::after': {
          position: 'absolute',
          top: -90,
          right: '8%',
          width: 220,
          height: 160,
          borderRadius: '50%',
          content: '""',
          pointerEvents: 'none',
          background: `radial-gradient(circle, ${alpha(theme.palette.primary.main, 0.16)}, transparent 68%)`,
          filter: 'blur(20px)',
        },
      }}
    >
      <Box
        sx={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          width: '100%',
          maxWidth,
          mx: 'auto',
          px: { xs: 2, sm: 3, lg: 4 },
          py: compact ? { xs: 1.8, sm: 2 } : { xs: 2.2, sm: 2.8 },
          alignItems: { xs: 'flex-start', md: 'center' },
          justifyContent: 'space-between',
          flexDirection: { xs: 'column', md: 'row' },
          gap: 2,
        }}
      >
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0 }}>
          {leading}
          {Icon && (
            <Box
              aria-hidden="true"
              sx={{
                display: 'grid',
                width: compact ? 40 : 46,
                height: compact ? 40 : 46,
                flexShrink: 0,
                placeItems: 'center',
                border: `1px solid ${alpha(theme.palette.primary.main, 0.24)}`,
                borderRadius: compact ? 2.8 : 3.2,
                color: 'primary.light',
                bgcolor: alpha(theme.palette.primary.main, 0.1),
                boxShadow: `inset 0 1px 0 ${alpha(theme.palette.common.white, 0.08)}, 0 10px 30px ${alpha(theme.palette.primary.main, 0.12)}`,
              }}
            >
              <Icon sx={{ fontSize: compact ? 21 : 24 }} />
            </Box>
          )}

          <Box sx={{ minWidth: 0 }}>
            {(eyebrow || badge) && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.35 }}>
                {eyebrow && (
                  <Typography
                    sx={{
                      color: 'primary.light',
                      fontSize: '0.67rem',
                      fontWeight: 780,
                      letterSpacing: '0.13em',
                      textTransform: 'uppercase',
                    }}
                  >
                    {eyebrow}
                  </Typography>
                )}
                {badge}
              </Stack>
            )}
            <Typography
              component="h1"
              variant="h5"
              sx={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                fontSize: compact ? '1.2rem' : undefined,
                whiteSpace: { xs: 'normal', sm: 'nowrap' },
              }}
            >
              {title}
            </Typography>
            {description && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{
                  mt: 0.45,
                  maxWidth: 720,
                  textWrap: 'balance',
                }}
              >
                {description}
              </Typography>
            )}
          </Box>
        </Stack>

        {actions && (
          <Box
            sx={{
              display: 'flex',
              width: { xs: '100%', md: 'auto' },
              flexShrink: 0,
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 1,
              '& > .MuiButton-root': {
                flex: { xs: '1 1 auto', sm: '0 0 auto' },
              },
            }}
          >
            {actions}
          </Box>
        )}
      </Box>
    </Box>
  );
}
