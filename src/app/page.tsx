"use client";

import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  AccountTreeRounded,
  ArrowForwardRounded,
  AutoAwesomeRounded,
  ChatBubbleRounded,
  CheckCircleRounded,
  CloseRounded,
  HubRounded,
  LockRounded,
  MemoryRounded,
  ShieldRounded,
} from '@mui/icons-material';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import FeedbackBanner from '@/frontend/components/FeedbackBanner';
import { TicketsSection } from '@/frontend/components/Tickets/TicketsSection';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useTour } from '@/frontend/contexts/TourContext';
import { chatService } from '@/frontend/services/chat';
import { flowService } from '@/frontend/services/flow';
import { modelService } from '@/frontend/services/model';
import {
  DASHBOARD_CARD_IDS,
  LEGACY_HIDDEN_DASHBOARD_CARD_IDS,
  isDashboardCardId,
  type DashboardCardId,
} from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/page');

interface SetupStep {
  id: Exclude<DashboardCardId, 'connectedApps'>;
  number: number;
  title: string;
  description: string;
  icon: typeof MemoryRounded;
  complete: boolean;
  available: boolean;
  status: string;
  href?: string;
  action: string;
}

interface WorkspaceStatus {
  /** null means the encrypted/local model store could not be checked. */
  models: number | null;
  assistants: number;
  conversations: number;
  loading: boolean;
  conversationsLoading: boolean;
}

export default function HomePage() {
  const theme = useTheme();
  const { t, tp } = useI18n();
  const { settings, updateSettings } = useStorage();
  const { startTour } = useTour();
  const [encryptionKeySet, setEncryptionKeySet] = useState(true);
  const [isUserEncryption, setIsUserEncryption] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ behindBy: number; branch: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatus>({
    models: null,
    assistants: 0,
    conversations: 0,
    loading: true,
    conversationsLoading: true,
  });
  const updateChecked = useRef(false);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([modelService.tryLoadModels(), flowService.loadFlows()]).then(([models, flows]) => {
      if (!active) return;
      setWorkspaceStatus((current) => ({
        ...current,
        models: models.status === 'fulfilled' && models.value !== null ? models.value.length : null,
        assistants: flows.status === 'fulfilled' ? flows.value.length : 0,
        loading: false,
      }));
    });
    void chatService.countConversations()
      .then((count) => {
        if (!active) return;
        setWorkspaceStatus((current) => ({
          ...current,
          conversations: count,
          conversationsLoading: false,
        }));
      })
      .catch((error) => {
        log.warn('Conversation presence check failed', error);
        if (!active) return;
        setWorkspaceStatus((current) => ({ ...current, conversationsLoading: false }));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!settings?.update?.checkOnStartup || updateChecked.current) return;
    updateChecked.current = true;
    void fetch('/api/update')
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => {
        if (data?.updateAvailable) {
          setUpdateInfo({ behindBy: data.behindBy, branch: data.branch });
        }
      })
      .catch((error) => log.warn('Update check failed', error));
  }, [settings?.update?.checkOnStartup]);

  useEffect(() => {
    const checkEncryptionStatus = async () => {
      try {
        const initResponse = await fetch('/api/encryption/secure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'check_initialized' }),
        });
        if (!initResponse.ok) {
          setEncryptionKeySet(false);
          return;
        }
        const initData = await initResponse.json();
        const initialized = initData.initialized === true;
        setEncryptionKeySet(initialized);
        if (!initialized) return;

        const userResponse = await fetch('/api/encryption/secure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'check_user_encryption' }),
        });
        if (userResponse.ok) {
          const userData = await userResponse.json();
          setIsUserEncryption(userData.userEncryption === true);
        }
      } catch (error) {
        log.error('Error checking encryption status', error);
        setEncryptionKeySet(false);
      }
    };
    void checkEncryptionStatus();
  }, []);

  const handleUpdateNow = async () => {
    setUpdating(true);
    setUpdateError(null);
    try {
      const response = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      });
      const data = await response.json();
      if (!response.ok || data.success === false) {
        setUpdateError(data.error || t('home.updateFailed'));
        setUpdating(false);
        return;
      }
      if (data.restarting) {
        let sawDown = false;
        const poll = async () => {
          try {
            const ping = await fetch('/api/cwd', { cache: 'no-store' });
            if (ping.ok && sawDown) {
              window.location.reload();
              return;
            }
          } catch {
            sawDown = true;
          }
          setTimeout(poll, 3000);
        };
        setTimeout(poll, 5000);
      } else {
        setUpdating(false);
        setUpdateInfo(null);
      }
    } catch (error) {
      log.error('Update failed', error);
      setUpdateError(t('home.updateFailed'));
      setUpdating(false);
    }
  };

  const aiReady = workspaceStatus.models !== null && workspaceStatus.models > 0;
  const aiCheckUnavailable = !workspaceStatus.loading && workspaceStatus.models === null;
  const assistantReady = workspaceStatus.assistants > 0;
  const talkReady = workspaceStatus.conversations > 0;
  const setupSteps: SetupStep[] = [
    {
      id: 'ai',
      number: 1,
      title: t('home.connectAi.title'),
      description: t('home.connectAi.description'),
      icon: MemoryRounded,
      complete: aiReady,
      available: true,
      status: workspaceStatus.loading
        ? t('home.checking')
        : aiReady
          ? t('home.connected')
          : aiCheckUnavailable
            ? t('home.openToCheck')
            : t('home.required'),
      href: aiReady || aiCheckUnavailable ? '/models' : '/models?add=1',
      action: aiReady ? t('home.connectAi.manage') : aiCheckUnavailable ? t('home.connectAi.open') : t('home.connectAi.action'),
    },
    {
      id: 'assistant',
      number: 2,
      title: t('home.agent.title'),
      description: t('home.agent.description'),
      icon: AutoAwesomeRounded,
      complete: assistantReady,
      available: aiReady,
      status: assistantReady ? tp('home.readyCount', workspaceStatus.assistants) : aiReady ? t('home.next') : t('home.afterAi'),
      href: aiReady ? '/flows?create=assistant' : undefined,
      action: assistantReady ? t('home.agent.another') : aiReady ? t('home.agent.openBuilder') : t('home.agent.connectFirst'),
    },
    {
      id: 'talk',
      number: 3,
      title: t('home.talk.title'),
      description: t('home.talk.description'),
      icon: ChatBubbleRounded,
      complete: talkReady,
      available: aiReady && assistantReady,
      status: workspaceStatus.conversationsLoading
        ? t('home.checking')
        : talkReady
        ? t('home.completed')
        : !aiReady
          ? t('home.afterAi')
          : assistantReady
            ? t('home.ready')
            : t('home.afterAgent'),
      href: aiReady && assistantReady ? '/chat' : undefined,
      action: !aiReady ? t('home.talk.finishAi') : assistantReady ? t('home.talk.start') : t('home.talk.createFirst'),
    },
  ];
  const persistedDismissedCards = useMemo<DashboardCardId[]>(() => {
    const onboarding = settings.onboarding;
    const stored = onboarding?.dashboardDismissedCards;
    if (Array.isArray(stored)) {
      // Explicit per-card state always wins; unknown values are ignored so a
      // future or corrupted entry cannot hide an unrelated card.
      return stored.filter(isDashboardCardId);
    }
    // Legacy collective flag only ever hid the three setup cards.
    return onboarding?.dashboardCardsHidden === true ? [...LEGACY_HIDDEN_DASHBOARD_CARD_IDS] : [];
  }, [settings.onboarding]);

  // Dismissals applied in this session are merged with the persisted list so a
  // quick sequence of clicks cannot overwrite an earlier dismissal while the
  // asynchronous settings write is still in flight.
  const [sessionDismissedCards, setSessionDismissedCards] = useState<DashboardCardId[]>([]);
  const dismissedCards = useMemo(
    () => new Set<DashboardCardId>([...persistedDismissedCards, ...sessionDismissedCards]),
    [persistedDismissedCards, sessionDismissedCards],
  );

  const persistDismissedCards = (nextDismissed: Set<DashboardCardId>) => {
    void updateSettings({
      ...settings,
      onboarding: {
        ...(settings.onboarding ?? {}),
        completed: settings.onboarding?.completed ?? false,
        // Neutralize the legacy collective flag once explicit state exists.
        dashboardCardsHidden: false,
        dashboardDismissedCards: DASHBOARD_CARD_IDS.filter((id) => nextDismissed.has(id)),
      },
    });
  };

  const dismissDashboardCard = (cardId: DashboardCardId) => {
    if (dismissedCards.has(cardId)) return;
    setSessionDismissedCards((current) => (current.includes(cardId) ? current : [...current, cardId]));
    persistDismissedCards(new Set<DashboardCardId>([...dismissedCards, cardId]));
  };

  const visibleSetupSteps = setupSteps.filter((step) => !dismissedCards.has(step.id));
  const showConnectedAppsCard = !dismissedCards.has('connectedApps');

  const handleStartTour = () => {
    // The guided tour points at the setup cards, so restore them before it runs.
    const restored = new Set<DashboardCardId>(dismissedCards);
    const restoredAny = LEGACY_HIDDEN_DASHBOARD_CARD_IDS.filter((id) => restored.delete(id)).length > 0;
    if (restoredAny) {
      setSessionDismissedCards((current) =>
        current.filter((id) => !LEGACY_HIDDEN_DASHBOARD_CARD_IDS.includes(id)),
      );
      persistDismissedCards(restored);
    }
    startTour();
  };

  return (
    <Container maxWidth={false} disableGutters>
      <Box sx={{ width: 'min(100%, 1320px)', mx: 'auto', px: { xs: 2, sm: 3, lg: 5 }, pb: { xs: 7, md: 10 } }}>
        <Stack spacing={1.2} sx={{ pt: { xs: 2, md: 3 } }}>
          {updateInfo && (
            <Alert
              severity="info"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={handleUpdateNow}
                  disabled={updating}
                  startIcon={updating ? <CircularProgress size={16} color="inherit" /> : undefined}
                >
                  {updating ? t('home.updating') : t('home.updateNow')}
                </Button>
              }
            >
              {updating
                ? t('home.updateProgress')
                : tp('home.updateReady', updateInfo.behindBy, { branch: updateInfo.branch })}
            </Alert>
          )}

          {updateError && <Alert severity="error" onClose={() => setUpdateError(null)}>{updateError}</Alert>}

          {!encryptionKeySet ? (
            <Alert severity="warning" icon={<ShieldRounded />}>
              {t('home.passwordRequired')}{' '}
              <Link href="/settings" style={{ fontWeight: 700 }}>{t('common.settings')}</Link>.
            </Alert>
          ) : !isUserEncryption ? (
            <Alert severity="info" icon={<LockRounded />}>
              {t('home.passwordOptional')}{' '}
              <Link href="/settings" style={{ fontWeight: 700 }}>{t('common.settings')}</Link>.
            </Alert>
          ) : null}
        </Stack>

        <Box component="section" sx={{ pt: { xs: 5, md: 7 }, pb: { xs: 4, md: 5 } }}>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            justifyContent="space-between"
            alignItems={{ xs: 'flex-start', md: 'flex-end' }}
            spacing={2.5}
          >
            <Box sx={{ maxWidth: 760 }}>
              <Typography className="premium-eyebrow">{t('home.eyebrow')}</Typography>
              <Typography variant="h2" sx={{ mt: 1, maxWidth: 720 }}>
                {t('home.heading')}
              </Typography>
              <Typography variant="h6" color="text.secondary" sx={{ mt: 1.5, maxWidth: 700, fontWeight: 450, lineHeight: 1.55 }}>
                {t('home.intro')}
              </Typography>
            </Box>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="stretch">
              <Button variant="outlined" onClick={handleStartTour} startIcon={<AutoAwesomeRounded />}>
                {t('home.openGuide')}
              </Button>
            </Stack>
          </Stack>
        </Box>

        {visibleSetupSteps.length > 0 && (
        <Box
          component="section"
          aria-label={t('home.gettingStarted')}
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: `repeat(${Math.min(visibleSetupSteps.length, 3)}, minmax(0, 1fr))` },
            gap: 2,
          }}
        >
          {visibleSetupSteps.map((step) => {
            const Icon = step.icon;
            const highlighted = step.available && !step.complete;
            return (
              <Paper
                key={step.id}
                component="article"
                className="stagger-in"
                elevation={0}
                aria-current={highlighted ? 'step' : undefined}
                sx={{
                  position: 'relative',
                  display: 'flex',
                  minHeight: { xs: 250, lg: 310 },
                  p: { xs: 2.5, sm: 3 },
                  overflow: 'hidden',
                  flexDirection: 'column',
                  border: 1,
                  borderColor: step.complete
                    ? alpha(theme.palette.success.main, 0.45)
                    : highlighted
                      ? alpha(theme.palette.primary.main, 0.48)
                      : 'divider',
                  borderRadius: 4,
                  bgcolor: alpha(theme.palette.background.paper, step.available ? 0.78 : 0.5),
                  opacity: step.available ? 1 : 0.7,
                  boxShadow: highlighted ? `0 22px 70px ${alpha(theme.palette.primary.main, 0.13)}` : 'none',
                  transition: 'transform 220ms ease, border-color 220ms ease, box-shadow 220ms ease',
                  '&:hover': step.available ? {
                    transform: 'translateY(-4px)',
                    boxShadow: `0 26px 74px ${alpha(theme.palette.primary.main, 0.16)}`,
                  } : undefined,
                  '&::before': {
                    position: 'absolute',
                    top: -80,
                    right: -70,
                    width: 190,
                    height: 190,
                    borderRadius: '50%',
                    content: '""',
                    background: `radial-gradient(circle, ${alpha(
                      step.complete ? theme.palette.success.main : theme.palette.primary.main,
                      step.available ? 0.18 : 0.07,
                    )}, transparent 68%)`,
                  },
                }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                  <Box
                    sx={{
                      display: 'grid',
                      width: 46,
                      height: 46,
                      placeItems: 'center',
                      borderRadius: 3,
                      color: step.complete ? 'success.main' : step.available ? 'primary.main' : 'text.disabled',
                      bgcolor: alpha(step.complete ? theme.palette.success.main : theme.palette.primary.main, 0.1),
                    }}
                  >
                    {step.complete ? <CheckCircleRounded /> : <Icon />}
                  </Box>
                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    <Chip
                      size="small"
                      color={step.complete ? 'success' : highlighted ? 'primary' : 'default'}
                      variant="outlined"
                      label={step.status}
                    />
                    <Tooltip title={t(`home.dismissCard.${step.id}`)} disableInteractive>
                      <IconButton
                        size="small"
                        aria-label={t(`home.dismissCard.${step.id}`)}
                        onClick={() => dismissDashboardCard(step.id)}
                        sx={{ color: 'text.secondary' }}
                      >
                        <CloseRounded fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Stack>

                <Typography variant="overline" color="text.secondary" sx={{ mt: 3 }}>
                  {t('home.step', { number: step.number })}
                </Typography>
                <Typography variant="h5" sx={{ mt: 0.3 }}>{step.title}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.65 }}>
                  {step.description}
                </Typography>

                <Box sx={{ mt: 'auto', pt: 3 }}>
                  {step.href ? (
                    <Button
                      component={Link}
                      href={step.href}
                      data-tour={step.id === 'ai'
                        ? 'manage-ai-setup'
                        : step.id === 'assistant'
                          ? 'dashboard-create-flow'
                          : undefined}
                      variant={highlighted ? 'contained' : 'outlined'}
                      endIcon={<ArrowForwardRounded />}
                      fullWidth
                    >
                      {step.action}
                    </Button>
                  ) : (
                    <Button
                      variant="outlined"
                      disabled
                      fullWidth
                      data-tour={step.id === 'assistant' ? 'dashboard-create-flow' : undefined}
                    >
                      {step.action}
                    </Button>
                  )}
                </Box>
              </Paper>
            );
          })}
        </Box>
        )}

        <TicketsSection />

        {showConnectedAppsCard && (
        <Paper
          component="section"
          elevation={0}
          sx={{
            mt: 2,
            p: { xs: 2.2, sm: 2.5 },
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { xs: 'flex-start', sm: 'center' },
            gap: 2,
            border: 1,
            borderColor: 'divider',
            borderRadius: 4,
            bgcolor: alpha(theme.palette.background.paper, 0.62),
          }}
        >
          <Box
            sx={{
              display: 'grid',
              width: 44,
              height: 44,
              flexShrink: 0,
              placeItems: 'center',
              borderRadius: 3,
              color: 'secondary.main',
              bgcolor: alpha(theme.palette.secondary.main, 0.1),
            }}
          >
            <HubRounded />
          </Box>
          <Box sx={{ flex: 1 }}>
            <Typography variant="subtitle1" fontWeight={760}>{t('home.apps.title')}</Typography>
            <Typography variant="body2" color="text.secondary">
              {t('home.apps.description')}
            </Typography>
          </Box>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <Button component={Link} href="/mcp" variant="text" endIcon={<ArrowForwardRounded />}>
              {t('nav.connectedApps')}
            </Button>
            <Tooltip title={t('home.dismissCard.connectedApps')} disableInteractive>
              <IconButton
                size="small"
                aria-label={t('home.dismissCard.connectedApps')}
                onClick={() => dismissDashboardCard('connectedApps')}
                sx={{ color: 'text.secondary' }}
              >
                <CloseRounded fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Paper>
        )}

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={{ xs: 1, sm: 3 }}
          sx={{ mt: 3.5, color: 'text.secondary' }}
        >
          <Stack direction="row" spacing={0.8} alignItems="center">
            <LockRounded sx={{ fontSize: 17, color: 'primary.main' }} />
            <Typography variant="caption">{t('home.trait.private')}</Typography>
          </Stack>
          <Stack direction="row" spacing={0.8} alignItems="center">
            <AccountTreeRounded sx={{ fontSize: 17, color: 'primary.main' }} />
            <Typography variant="caption">{t('home.trait.simple')}</Typography>
          </Stack>
          <Stack direction="row" spacing={0.8} alignItems="center">
            <ShieldRounded sx={{ fontSize: 17, color: 'primary.main' }} />
            <Typography variant="caption">{t('home.trait.expert')}</Typography>
          </Stack>
        </Stack>

        <Box sx={{ mt: { xs: 5, md: 7 } }}>
          <FeedbackBanner />
        </Box>
      </Box>
    </Container>
  );
}
