"use client";

import React, { useMemo, useState } from 'react';
import {
  Box,
  Chip,
  FormControl,
  InputLabel,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import BackupRoundedIcon from '@mui/icons-material/BackupRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import DataObjectRoundedIcon from '@mui/icons-material/DataObjectRounded';
import LockRoundedIcon from '@mui/icons-material/LockRounded';
import MicRoundedIcon from '@mui/icons-material/MicRounded';
import PaletteRoundedIcon from '@mui/icons-material/PaletteRounded';
import PrivacyTipRoundedIcon from '@mui/icons-material/PrivacyTipRounded';
import RocketLaunchRoundedIcon from '@mui/icons-material/RocketLaunchRounded';
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded';
import SettingsSuggestRoundedIcon from '@mui/icons-material/SettingsSuggestRounded';
import SystemUpdateAltRoundedIcon from '@mui/icons-material/SystemUpdateAltRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import EncryptionSettings from './EncryptionSettings';
import ThemeSettings from './ThemeSettings';
import GlobalEnvSettings from './GlobalEnvSettings';
import BackupSettings from './BackupSettings';
import SpeechRecognitionSettings from './SpeechRecognitionSettings';
import UpdateSettings from './UpdateSettings';
import OnboardingSettings from './OnboardingSettings';
import ExperimentalFeaturesSettings from './ExperimentalFeaturesSettings';
import PrivacySettings from './PrivacySettings';

type SettingsSectionId =
  | 'globalEnv'
  | 'encryption'
  | 'backup'
  | 'theme'
  | 'speech'
  | 'onboarding'
  | 'updates'
  | 'privacy'
  | 'experimental';

interface SettingsSection {
  id: SettingsSectionId;
  title: string;
  description: string;
  icon: React.ElementType;
  component: React.ComponentType;
}

interface SettingsCategory {
  id: string;
  title: string;
  description: string;
  sectionIds: SettingsSectionId[];
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'globalEnv',
    title: 'Global variables',
    description: 'Manage shared values and secrets used by your connected services.',
    icon: DataObjectRoundedIcon,
    component: GlobalEnvSettings,
  },
  {
    id: 'encryption',
    title: 'Encryption',
    description: 'Control how credentials and other sensitive local data are protected.',
    icon: LockRoundedIcon,
    component: EncryptionSettings,
  },
  {
    id: 'backup',
    title: 'Backup & restore',
    description: 'Export your setup for safekeeping or restore it on this installation.',
    icon: BackupRoundedIcon,
    component: BackupSettings,
  },
  {
    id: 'theme',
    title: 'Appearance',
    description: 'Choose the visual mode that makes FLUJO most comfortable to use.',
    icon: PaletteRoundedIcon,
    component: ThemeSettings,
  },
  {
    id: 'speech',
    title: 'Speech recognition',
    description: 'Configure voice input and browser speech-recognition preferences.',
    icon: MicRoundedIcon,
    component: SpeechRecognitionSettings,
  },
  {
    id: 'onboarding',
    title: 'Onboarding',
    description: 'Review the guided setup experience or launch the product tour again.',
    icon: RocketLaunchRoundedIcon,
    component: OnboardingSettings,
  },
  {
    id: 'updates',
    title: 'Updates',
    description: 'Check your installed version and manage automatic update checks.',
    icon: SystemUpdateAltRoundedIcon,
    component: UpdateSettings,
  },
  {
    id: 'privacy',
    title: 'Privacy & usage',
    description: 'Decide which anonymous usage signals this installation may share.',
    icon: PrivacyTipRoundedIcon,
    component: PrivacySettings,
  },
  {
    id: 'experimental',
    title: 'Experimental features',
    description: 'Preview advanced capabilities that are still under active development.',
    icon: ScienceRoundedIcon,
    component: ExperimentalFeaturesSettings,
  },
];

const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'security',
    title: 'Data & security',
    description: 'Credentials, protection and portability',
    sectionIds: ['globalEnv', 'encryption', 'backup'],
  },
  {
    id: 'experience',
    title: 'Experience',
    description: 'Appearance, voice and guidance',
    sectionIds: ['theme', 'speech', 'onboarding'],
  },
  {
    id: 'system',
    title: 'System',
    description: 'Maintenance, privacy and labs',
    sectionIds: ['updates', 'privacy', 'experimental'],
  },
];

export default function Settings() {
  const theme = useTheme();
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>('globalEnv');

  const sectionsById = useMemo(
    () =>
      new Map<SettingsSectionId, SettingsSection>(
        SETTINGS_SECTIONS.map((section) => [section.id, section])
      ),
    []
  );
  const activeSection = sectionsById.get(activeSectionId) ?? SETTINGS_SECTIONS[0];
  const ActiveSectionIcon = activeSection.icon;
  const mobileMenuItems = SETTINGS_CATEGORIES.flatMap((category) => [
    <ListSubheader key={`${category.id}-heading`}>{category.title}</ListSubheader>,
    ...category.sectionIds.map((sectionId) => {
      const section = sectionsById.get(sectionId);
      if (!section) return null;
      const SectionIcon = section.icon;
      return (
        <MenuItem key={section.id} value={section.id}>
          <ListItemIcon>
            <SectionIcon fontSize="small" />
          </ListItemIcon>
          {section.title}
        </MenuItem>
      );
    }),
  ]);

  const handleMobileSectionChange = (event: SelectChangeEvent<SettingsSectionId>) => {
    setActiveSectionId(event.target.value as SettingsSectionId);
  };

  return (
    <Box
      component="section"
      sx={{
        minHeight: '100%',
        px: { xs: 2, sm: 3, lg: 4 },
        py: { xs: 2, sm: 3, lg: 4 },
        background:
          theme.palette.mode === 'dark'
            ? `radial-gradient(circle at 12% 8%, ${alpha(theme.palette.primary.main, 0.1)}, transparent 28%)`
            : `radial-gradient(circle at 12% 8%, ${alpha(theme.palette.primary.main, 0.07)}, transparent 30%)`,
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 1440, mx: 'auto' }}>
        <Paper
          component="header"
          variant="outlined"
          sx={{
            position: 'relative',
            overflow: 'hidden',
            mb: { xs: 2, md: 3 },
            p: { xs: 2.5, sm: 3.5, md: 4 },
            borderRadius: 4,
            background: `linear-gradient(135deg, ${alpha(
              theme.palette.primary.main,
              theme.palette.mode === 'dark' ? 0.2 : 0.12
            )} 0%, ${alpha(theme.palette.background.paper, 0.96)} 58%, ${alpha(
              theme.palette.info.main,
              theme.palette.mode === 'dark' ? 0.1 : 0.06
            )} 100%)`,
            boxShadow:
              theme.palette.mode === 'dark'
                ? '0 24px 70px rgba(0, 0, 0, 0.24)'
                : '0 24px 70px rgba(31, 41, 55, 0.08)',
            '&::after': {
              content: '""',
              position: 'absolute',
              width: 260,
              height: 260,
              right: -90,
              top: -130,
              borderRadius: '50%',
              background: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.12 : 0.08),
              filter: 'blur(2px)',
              pointerEvents: 'none',
            },
          }}
        >
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            spacing={3}
            sx={{ position: 'relative', zIndex: 1 }}
          >
            <Box>
              <Chip
                icon={<TuneRoundedIcon />}
                label="Workspace controls"
                size="small"
                variant="outlined"
                sx={{
                  mb: 1.5,
                  borderColor: alpha(theme.palette.primary.main, 0.3),
                  bgcolor: alpha(theme.palette.background.paper, 0.52),
                  fontWeight: 650,
                }}
              />
              <Typography
                component="h1"
                variant="h3"
                sx={{
                  mb: 1,
                  fontSize: { xs: '2rem', sm: '2.5rem', md: '3rem' },
                  letterSpacing: '-0.04em',
                  lineHeight: 1.04,
                }}
              >
                Settings
              </Typography>
              <Typography color="text.secondary" sx={{ maxWidth: 660, fontSize: { sm: '1.05rem' } }}>
                Shape FLUJO around the way you work. Your data, experience, and system controls
                now live in one focused workspace.
              </Typography>
            </Box>

            <Box
              aria-hidden
              sx={{
                display: { xs: 'none', sm: 'grid' },
                placeItems: 'center',
                flex: '0 0 auto',
                width: { sm: 88, md: 108 },
                height: { sm: 88, md: 108 },
                borderRadius: 4,
                color: 'primary.main',
                border: `1px solid ${alpha(theme.palette.primary.main, 0.22)}`,
                bgcolor: alpha(theme.palette.background.paper, 0.56),
                backdropFilter: 'blur(14px)',
                boxShadow: `inset 0 1px 0 ${alpha(theme.palette.common.white, 0.15)}`,
              }}
            >
              <SettingsSuggestRoundedIcon sx={{ fontSize: { sm: 46, md: 58 } }} />
            </Box>
          </Stack>
        </Paper>

        <Paper
          variant="outlined"
          sx={{
            display: { xs: 'block', md: 'none' },
            p: 1.5,
            mb: 2,
            borderRadius: 3,
            boxShadow: theme.shadows[1],
          }}
        >
          <FormControl fullWidth size="small">
            <InputLabel id="mobile-settings-section-label">Settings section</InputLabel>
            <Select<SettingsSectionId>
              labelId="mobile-settings-section-label"
              value={activeSectionId}
              label="Settings section"
              onChange={handleMobileSectionChange}
              renderValue={() => (
                <Stack direction="row" alignItems="center" spacing={1.25}>
                  <ActiveSectionIcon color="primary" fontSize="small" />
                  <Typography variant="body2" fontWeight={650}>
                    {activeSection.title}
                  </Typography>
                </Stack>
              )}
            >
              {mobileMenuItems}
            </Select>
          </FormControl>
        </Paper>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '300px minmax(0, 1fr)', lg: '320px minmax(0, 1fr)' },
            gap: { xs: 2, md: 3 },
            alignItems: 'start',
          }}
        >
          <Stack
            component="nav"
            aria-label="Settings sections"
            spacing={1.5}
            sx={{ display: { xs: 'none', md: 'flex' } }}
          >
            {SETTINGS_CATEGORIES.map((category) => (
              <Paper
                key={category.id}
                variant="outlined"
                sx={{
                  p: 1,
                  borderRadius: 3,
                  boxShadow: theme.shadows[1],
                  bgcolor: alpha(theme.palette.background.paper, 0.88),
                }}
              >
                <Box sx={{ px: 1.25, pt: 1, pb: 1.25 }}>
                  <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 750, letterSpacing: '0.1em' }}>
                    {category.title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    {category.description}
                  </Typography>
                </Box>

                <List disablePadding>
                  {category.sectionIds.map((sectionId) => {
                    const section = sectionsById.get(sectionId);
                    if (!section) return null;
                    const SectionIcon = section.icon;
                    const selected = activeSectionId === section.id;

                    return (
                      <ListItemButton
                        key={section.id}
                        id={`settings-nav-${section.id}`}
                        selected={selected}
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => setActiveSectionId(section.id)}
                        sx={{
                          mb: 0.5,
                          minHeight: 52,
                          borderRadius: 2,
                          border: '1px solid transparent',
                          '&:last-of-type': { mb: 0 },
                          '&.Mui-selected': {
                            borderColor: alpha(theme.palette.primary.main, 0.24),
                            bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.16 : 0.09),
                          },
                          '&.Mui-selected:hover': {
                            bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.13),
                          },
                        }}
                      >
                        <ListItemIcon sx={{ minWidth: 44 }}>
                          <Box
                            sx={{
                              display: 'grid',
                              placeItems: 'center',
                              width: 34,
                              height: 34,
                              borderRadius: 1.75,
                              color: selected ? 'primary.main' : 'text.secondary',
                              bgcolor: selected
                                ? alpha(theme.palette.primary.main, 0.13)
                                : alpha(theme.palette.text.primary, 0.05),
                            }}
                          >
                            <SectionIcon fontSize="small" />
                          </Box>
                        </ListItemIcon>
                        <ListItemText
                          primary={section.title}
                          primaryTypographyProps={{
                            fontSize: '0.9rem',
                            fontWeight: selected ? 700 : 550,
                          }}
                        />
                        <ChevronRightRoundedIcon
                          fontSize="small"
                          sx={{
                            color: selected ? 'primary.main' : 'text.disabled',
                            transform: selected ? 'translateX(2px)' : 'none',
                            transition: 'transform 160ms ease',
                          }}
                        />
                      </ListItemButton>
                    );
                  })}
                </List>
              </Paper>
            ))}
          </Stack>

          <Paper
            component="section"
            aria-labelledby={`settings-panel-title-${activeSection.id}`}
            variant="outlined"
            sx={{
              minWidth: 0,
              overflow: 'hidden',
              borderRadius: { xs: 3, md: 4 },
              bgcolor: alpha(theme.palette.background.paper, 0.94),
              boxShadow:
                theme.palette.mode === 'dark'
                  ? '0 24px 70px rgba(0, 0, 0, 0.2)'
                  : '0 24px 70px rgba(31, 41, 55, 0.07)',
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: { xs: 1.5, sm: 2 },
                p: { xs: 2, sm: 3 },
                borderBottom: 1,
                borderColor: 'divider',
                background: `linear-gradient(120deg, ${alpha(theme.palette.primary.main, 0.08)}, transparent 58%)`,
              }}
            >
              <Box
                sx={{
                  display: 'grid',
                  placeItems: 'center',
                  flex: '0 0 auto',
                  width: { xs: 44, sm: 52 },
                  height: { xs: 44, sm: 52 },
                  borderRadius: 2.5,
                  color: 'primary.main',
                  bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.1),
                  border: `1px solid ${alpha(theme.palette.primary.main, 0.18)}`,
                }}
              >
                <ActiveSectionIcon sx={{ fontSize: { xs: 24, sm: 28 } }} />
              </Box>

              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                  id={`settings-panel-title-${activeSection.id}`}
                  component="h2"
                  variant="h4"
                  sx={{ fontSize: { xs: '1.35rem', sm: '1.65rem' }, letterSpacing: '-0.02em' }}
                >
                  {activeSection.title}
                </Typography>
                <Typography color="text.secondary" variant="body2" sx={{ mt: 0.35 }}>
                  {activeSection.description}
                </Typography>
              </Box>

              <Chip
                label={`${SETTINGS_SECTIONS.findIndex((section) => section.id === activeSection.id) + 1} / ${SETTINGS_SECTIONS.length}`}
                size="small"
                variant="outlined"
                sx={{ display: { xs: 'none', sm: 'inline-flex' }, color: 'text.secondary' }}
              />
            </Box>

            <Box sx={{ p: { xs: 2, sm: 3, lg: 4 } }}>
              {SETTINGS_SECTIONS.map((section) => {
                const SectionComponent = section.component;
                const selected = activeSection.id === section.id;

                return (
                  <Box
                    key={section.id}
                    hidden={!selected}
                  >
                    <SectionComponent />
                  </Box>
                );
              })}
            </Box>
          </Paper>
        </Box>
      </Box>
    </Box>
  );
}
