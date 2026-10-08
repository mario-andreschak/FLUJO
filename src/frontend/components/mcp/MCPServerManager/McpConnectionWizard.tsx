'use client';

import React, { useEffect, useState } from 'react';
import {
  Box,
  Chip,
  Dialog,
  DialogContent,
  IconButton,
  LinearProgress,
  Paper,
  Typography,
} from '@mui/material';
import { alpha, keyframes, useTheme } from '@mui/material/styles';
import type { SvgIconComponent } from '@mui/icons-material';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import CloudQueueRoundedIcon from '@mui/icons-material/CloudQueueRounded';
import CodeRoundedIcon from '@mui/icons-material/CodeRounded';
import ExploreRoundedIcon from '@mui/icons-material/ExploreRounded';
import GitHubIcon from '@mui/icons-material/GitHub';
import LaptopRoundedIcon from '@mui/icons-material/LaptopRounded';
import RocketLaunchRoundedIcon from '@mui/icons-material/RocketLaunchRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';

import { useI18n } from '@/frontend/contexts/I18nContext';
import type { ServerSetupTab } from './Modals/ServerModal/types';
import McpAiConnectionPanel from './McpAiConnectionPanel';
import AskFlujoButton from '@/frontend/components/AskFlujo/AskFlujoButton';
import BugReportButton from '@/frontend/components/BugReport/BugReportButton';

type WizardStep = 'welcome' | 'ai' | 'discovery' | 'source';

export interface McpConnectionWizardProps {
  open: boolean;
  onClose: () => void;
  onChooseSetup: (tab: ServerSetupTab) => void;
  onManualCreation: () => void;
  onInstalled: (serverName: string) => void | Promise<void>;
  onAuthenticate: (serverName: string) => Promise<void>;
}

const drift = keyframes`
  0%, 100% { transform: translate3d(0, 0, 0) rotate(0deg); }
  50% { transform: translate3d(0, -9px, 0) rotate(5deg); }
`;

const arrive = keyframes`
  from { opacity: 0; transform: translate3d(18px, 0, 0) scale(.985); }
  to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
`;

function OptionCard({
  icon: Icon,
  title,
  description,
  badge,
  onClick,
}: {
  icon: SvgIconComponent;
  title: string;
  description: string;
  badge?: string;
  onClick: () => void;
}) {
  const theme = useTheme();

  return (
    <Paper
      component="button"
      type="button"
      variant="outlined"
      onClick={onClick}
      sx={{
        position: 'relative',
        width: '100%',
        minHeight: 150,
        p: 2.2,
        borderRadius: 3,
        color: 'text.primary',
        textAlign: 'left',
        cursor: 'pointer',
        font: 'inherit',
        background: `linear-gradient(145deg, ${alpha(theme.palette.primary.main, 0.08)}, ${alpha(theme.palette.background.paper, 0.72)} 55%)`,
        transition: 'transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
        '&:hover': {
          transform: 'translateY(-3px) rotate(-.2deg)',
          borderColor: alpha(theme.palette.primary.main, 0.7),
          boxShadow: `0 16px 38px ${alpha(theme.palette.primary.main, 0.16)}`,
        },
        '&:focus-visible': {
          outline: `3px solid ${alpha(theme.palette.primary.main, 0.3)}`,
          outlineOffset: 3,
        },
      }}
    >
      {badge ? (
        <Chip label={badge} size="small" color="primary" sx={{ position: 'absolute', top: 12, right: 12 }} />
      ) : null}
      <Box
        sx={{
          width: 43,
          height: 43,
          display: 'grid',
          placeItems: 'center',
          mb: 1.3,
          borderRadius: 2.4,
          color: 'primary.main',
          bgcolor: alpha(theme.palette.primary.main, 0.12),
        }}
      >
        <Icon />
      </Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 720, pr: badge ? 7 : 0 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.45 }}>
        {description}
      </Typography>
    </Paper>
  );
}

function ChoiceGrid({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fit, minmax(210px, 1fr))' }, gap: 1.5 }}>
      {children}
    </Box>
  );
}

export default function McpConnectionWizard({
  open,
  onClose,
  onChooseSetup,
  onManualCreation,
  onInstalled,
  onAuthenticate,
}: McpConnectionWizardProps) {
  const theme = useTheme();
  const { t } = useI18n();
  const [step, setStep] = useState<WizardStep>('welcome');
  const [history, setHistory] = useState<WizardStep[]>([]);

  useEffect(() => {
    if (!open) return;
    setStep('welcome');
    setHistory([]);
  }, [open]);

  const go = (nextStep: WizardStep) => {
    setHistory((current) => [...current, step]);
    setStep(nextStep);
  };

  const back = () => {
    setHistory((current) => {
      const previous = current[current.length - 1];
      if (previous) setStep(previous);
      return current.slice(0, -1);
    });
  };

  const progress = step === 'welcome' ? 18 : step === 'ai' ? 76 : 62;

  const renderBody = () => {
    if (step === 'welcome') {
      return (
        <>
          <Chip
            icon={<AutoAwesomeRoundedIcon />}
            label={t('mcp.wizard.guidedSetup')}
            color="primary"
            variant="outlined"
            sx={{ mb: 2 }}
          />
          <Typography variant="h4">{t('mcp.wizard.welcomeTitle')}</Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mt: 1, mb: 3, maxWidth: 680 }}>
            {t('mcp.wizard.welcomeDescription')}
          </Typography>
          <ChoiceGrid>
            <OptionCard
              icon={AutoAwesomeRoundedIcon}
              title={t('mcp.ai.optionTitle')}
              description={t('mcp.ai.optionDescription')}
              badge={t('mcp.wizard.recommended')}
              onClick={() => go('ai')}
            />
            <OptionCard
              icon={RocketLaunchRoundedIcon}
              title={t('mcp.wizard.helpChoose')}
              description={t('mcp.wizard.helpChooseDescription')}
              onClick={() => go('discovery')}
            />
            <OptionCard
              icon={CodeRoundedIcon}
              title={t('mcp.wizard.haveDetails')}
              description={t('mcp.wizard.haveDetailsDescription')}
              onClick={() => go('source')}
            />
            <OptionCard
              icon={TuneRoundedIcon}
              title={t('mcp.wizard.expert')}
              description={t('mcp.wizard.expertDescription')}
              onClick={onManualCreation}
            />
          </ChoiceGrid>
        </>
      );
    }

    if (step === 'ai') {
      return (
        <McpAiConnectionPanel
          onInstalled={onInstalled}
          onAuthenticate={onAuthenticate}
          onManual={onManualCreation}
        />
      );
    }

    if (step === 'discovery') {
      return (
        <>
          <Typography variant="overline" color="primary.main">{t('mcp.wizard.readyMadeEyebrow')}</Typography>
          <Typography variant="h4">{t('mcp.wizard.discoveryTitle')}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 3, maxWidth: 700 }}>
            {t('mcp.wizard.discoveryDescription')}
          </Typography>
          <ChoiceGrid>
            <OptionCard
              icon={AutoAwesomeRoundedIcon}
              title={t('mcp.wizard.quickPicks')}
              description={t('mcp.wizard.quickPicksDescription')}
              badge={t('mcp.wizard.recommended')}
              onClick={() => onChooseSetup('spotlight')}
            />
            <OptionCard
              icon={ExploreRoundedIcon}
              title={t('mcp.wizard.marketplace')}
              description={t('mcp.wizard.marketplaceDescription')}
              onClick={() => onChooseSetup('marketplace')}
            />
            <OptionCard
              icon={CodeRoundedIcon}
              title={t('mcp.wizard.customApp')}
              description={t('mcp.wizard.customAppDescription')}
              onClick={() => go('source')}
            />
          </ChoiceGrid>
        </>
      );
    }

    return (
      <>
        <Typography variant="overline" color="primary.main">{t('mcp.wizard.yourAppEyebrow')}</Typography>
        <Typography variant="h4">{t('mcp.wizard.sourceTitle')}</Typography>
        <Typography color="text.secondary" sx={{ mt: 1, mb: 3, maxWidth: 700 }}>
          {t('mcp.wizard.sourceDescription')}
        </Typography>
        <ChoiceGrid>
          <OptionCard
            icon={CloudQueueRoundedIcon}
            title={t('mcp.wizard.remoteApp')}
            description={t('mcp.wizard.remoteAppDescription')}
            onClick={() => onChooseSetup('remote')}
          />
          <OptionCard
            icon={GitHubIcon}
            title={t('mcp.wizard.githubApp')}
            description={t('mcp.wizard.githubAppDescription')}
            onClick={() => onChooseSetup('github')}
          />
          <OptionCard
            icon={LaptopRoundedIcon}
            title={t('mcp.wizard.localApp')}
            description={t('mcp.wizard.localAppDescription')}
            onClick={() => onChooseSetup('configure')}
          />
        </ChoiceGrid>
      </>
    );
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth={step === 'ai' ? 'lg' : 'md'} aria-label={t('mcp.wizard.welcomeTitle')}>
      <DialogContent
        data-tour="mcp-setup-wizard"
        sx={{
          position: 'relative',
          minHeight: { xs: 560, sm: 590 },
          p: { xs: 2.2, sm: 4 },
          overflowX: 'hidden',
          overflowY: 'auto',
        }}
      >
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            width: 220,
            height: 220,
            borderRadius: '50%',
            top: -120,
            right: -70,
            bgcolor: alpha(theme.palette.secondary.main, 0.12),
            filter: 'blur(1px)',
            animation: `${drift} 6s ease-in-out infinite`,
          }}
        />
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            width: 150,
            height: 150,
            borderRadius: 5,
            bottom: -100,
            left: -70,
            bgcolor: alpha(theme.palette.primary.main, 0.1),
            transform: 'rotate(24deg)',
            animation: `${drift} 7s ease-in-out -2s infinite`,
          }}
        />

        <Box sx={{ position: 'relative', zIndex: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            {history.length ? (
              <IconButton onClick={back} aria-label={t('mcp.wizard.backAria')}>
                <ArrowBackRoundedIcon />
              </IconButton>
            ) : (
              <Box sx={{ width: 40 }} />
            )}
            <Box sx={{ flex: 1 }}>
              <LinearProgress variant="determinate" value={progress} aria-label={t('mcp.wizard.progressAria')} />
            </Box>
            <Box display="flex" alignItems="center" gap={0.5} flexShrink={0}>
              <AskFlujoButton />
              <BugReportButton variant="icon" />
              <IconButton onClick={onClose} aria-label={t('mcp.modal.close')}>
                <CloseRoundedIcon />
              </IconButton>
            </Box>
          </Box>

          <Box
            key={step}
            sx={{
              animation: `${arrive} 260ms ease-out both`,
              '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
            }}
          >
            {renderBody()}
          </Box>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
