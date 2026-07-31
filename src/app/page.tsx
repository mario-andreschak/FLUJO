"use client";

import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Paper,
  Stack,
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
  HubRounded,
  LockRounded,
  MemoryRounded,
  ShieldRounded,
} from '@mui/icons-material';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import FeedbackBanner from '@/frontend/components/FeedbackBanner';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useTour } from '@/frontend/contexts/TourContext';
import { flowService } from '@/frontend/services/flow';
import { modelService } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/page');

interface SetupStep {
  id: 'ai' | 'assistant' | 'talk';
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
  loading: boolean;
}

export default function HomePage() {
  const theme = useTheme();
  const { settings } = useStorage();
  const { startTour } = useTour();
  const [encryptionKeySet, setEncryptionKeySet] = useState(true);
  const [isUserEncryption, setIsUserEncryption] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ behindBy: number; branch: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatus>({
    models: null,
    assistants: 0,
    loading: true,
  });
  const updateChecked = useRef(false);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([modelService.tryLoadModels(), flowService.loadFlows()]).then(([models, flows]) => {
      if (!active) return;
      setWorkspaceStatus({
        models: models.status === 'fulfilled' && models.value !== null ? models.value.length : null,
        assistants: flows.status === 'fulfilled' ? flows.value.length : 0,
        loading: false,
      });
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
        setUpdateError(data.error || 'Update failed.');
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
      setUpdateError('Update failed.');
      setUpdating(false);
    }
  };

  const aiReady = workspaceStatus.models !== null && workspaceStatus.models > 0;
  const aiCheckUnavailable = !workspaceStatus.loading && workspaceStatus.models === null;
  const assistantReady = workspaceStatus.assistants > 0;
  const setupSteps: SetupStep[] = [
    {
      id: 'ai',
      number: 1,
      title: 'Connect your AI',
      description: 'Choose the AI provider and model FLUJO will use. Everything else starts here.',
      icon: MemoryRounded,
      complete: aiReady,
      available: true,
      status: workspaceStatus.loading
        ? 'Checking…'
        : aiReady
          ? 'Connected'
          : aiCheckUnavailable
            ? 'Open to check'
            : 'Required',
      href: aiReady || aiCheckUnavailable ? '/models' : '/models?add=1',
      action: aiReady ? 'Manage AI setup' : aiCheckUnavailable ? 'Open AI setup' : 'Connect AI',
    },
    {
      id: 'assistant',
      number: 2,
      title: 'Create an agent',
      description: 'Name it and add its job one plain-language step at a time in the simple builder.',
      icon: AutoAwesomeRounded,
      complete: assistantReady,
      available: aiReady,
      status: assistantReady ? `${workspaceStatus.assistants} ready` : aiReady ? 'Next' : 'After AI setup',
      href: aiReady ? '/flows?create=assistant' : undefined,
      action: assistantReady ? 'Create another' : aiReady ? 'Open simple builder' : 'Connect AI first',
    },
    {
      id: 'talk',
      number: 3,
      title: 'Talk to your agent',
      description: 'Use it in a familiar chat. Return to its recipe whenever you want to improve it.',
      icon: ChatBubbleRounded,
      complete: false,
      available: aiReady && assistantReady,
      status: !aiReady ? 'After AI setup' : assistantReady ? 'Ready' : 'After your first agent',
      href: aiReady && assistantReady ? '/chat' : undefined,
      action: !aiReady ? 'Finish AI setup first' : assistantReady ? 'Start talking' : 'Create an agent first',
    },
  ];

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
                  {updating ? 'Updating…' : 'Update now'}
                </Button>
              }
            >
              {updating
                ? 'Updating FLUJO and restarting — this page will reconnect automatically.'
                : `A FLUJO update is ready (${updateInfo.behindBy} new commit${updateInfo.behindBy === 1 ? '' : 's'} on ${updateInfo.branch}).`}
            </Alert>
          )}

          {updateError && <Alert severity="error" onClose={() => setUpdateError(null)}>{updateError}</Alert>}

          {!encryptionKeySet ? (
            <Alert severity="warning" icon={<ShieldRounded />}>
              Add a private password to protect your connected accounts in{' '}
              <Link href="/settings" style={{ fontWeight: 700 }}>Settings</Link>.
            </Alert>
          ) : !isUserEncryption ? (
            <Alert severity="info" icon={<LockRounded />}>
              Your information stays on this device. For extra protection, choose a private password in{' '}
              <Link href="/settings" style={{ fontWeight: 700 }}>Settings</Link>.
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
              <Typography className="premium-eyebrow">Your FLUJO setup</Typography>
              <Typography variant="h2" sx={{ mt: 1, maxWidth: 720 }}>
                Set up once. Then just use it.
              </Typography>
              <Typography variant="h6" color="text.secondary" sx={{ mt: 1.5, maxWidth: 700, fontWeight: 450, lineHeight: 1.55 }}>
                Follow these three steps in order. FLUJO keeps the technical details available without putting them in your way.
              </Typography>
            </Box>
            <Button variant="outlined" onClick={startTour} startIcon={<AutoAwesomeRounded />}>
              Open setup guide
            </Button>
          </Stack>
        </Box>

        <Box
          component="section"
          aria-label="Getting started"
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, minmax(0, 1fr))' },
            gap: 2,
          }}
        >
          {setupSteps.map((step) => {
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
                  <Chip
                    size="small"
                    color={step.complete ? 'success' : highlighted ? 'primary' : 'default'}
                    variant="outlined"
                    label={step.status}
                  />
                </Stack>

                <Typography variant="overline" color="text.secondary" sx={{ mt: 3 }}>
                  Step {step.number}
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
                      variant={highlighted ? 'contained' : 'outlined'}
                      endIcon={<ArrowForwardRounded />}
                      fullWidth
                    >
                      {step.action}
                    </Button>
                  ) : (
                    <Button variant="outlined" disabled fullWidth>{step.action}</Button>
                  )}
                </Box>
              </Paper>
            );
          })}
        </Box>

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
            <Typography variant="subtitle1" fontWeight={760}>Connected Apps are optional</Typography>
            <Typography variant="body2" color="text.secondary">
              Add files or services only when an agent needs them. A basic agent works with AI setup alone.
            </Typography>
          </Box>
          <Button component={Link} href="/mcp" variant="text" endIcon={<ArrowForwardRounded />}>
            Connected Apps
          </Button>
        </Paper>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={{ xs: 1, sm: 3 }}
          sx={{ mt: 3.5, color: 'text.secondary' }}
        >
          <Stack direction="row" spacing={0.8} alignItems="center">
            <LockRounded sx={{ fontSize: 17, color: 'primary.main' }} />
            <Typography variant="caption">Private on your device</Typography>
          </Stack>
          <Stack direction="row" spacing={0.8} alignItems="center">
            <AccountTreeRounded sx={{ fontSize: 17, color: 'primary.main' }} />
            <Typography variant="caption">Simple mode by default</Typography>
          </Stack>
          <Stack direction="row" spacing={0.8} alignItems="center">
            <ShieldRounded sx={{ fontSize: 17, color: 'primary.main' }} />
            <Typography variant="caption">Expert controls when you need them</Typography>
          </Stack>
        </Stack>

        <Box sx={{ mt: { xs: 5, md: 7 } }}>
          <FeedbackBanner />
        </Box>
      </Box>
    </Container>
  );
}
