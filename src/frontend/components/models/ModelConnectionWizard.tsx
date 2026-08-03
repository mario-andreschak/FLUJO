"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, keyframes, useTheme } from '@mui/material/styles';
import type { SvgIconComponent } from '@mui/icons-material';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import BoltRoundedIcon from '@mui/icons-material/BoltRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import CloudQueueRoundedIcon from '@mui/icons-material/CloudQueueRounded';
import ComputerRoundedIcon from '@mui/icons-material/ComputerRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import CreditCardRoundedIcon from '@mui/icons-material/CreditCardRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import KeyRoundedIcon from '@mui/icons-material/KeyRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import RocketLaunchRoundedIcon from '@mui/icons-material/RocketLaunchRounded';
import SavingsRoundedIcon from '@mui/icons-material/SavingsRounded';
import SchoolRoundedIcon from '@mui/icons-material/SchoolRounded';
import SmartToyRoundedIcon from '@mui/icons-material/SmartToyRounded';
import TerminalRoundedIcon from '@mui/icons-material/TerminalRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded';

import { Model } from '@/shared/types';
import { readNdjsonStream } from '@/frontend/utils/ndjsonReader';
import {
  buildGuidedModels,
  GuidedConnectionKind,
  guidedBundleNames,
} from './connectionWizardCatalog';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';

type Experience = 'beginner' | 'familiar';
type WizardStep =
  | 'welcome'
  | 'budget'
  | 'location'
  | 'free-provider'
  | 'subscription-provider'
  | 'paid-provider'
  | 'setup'
  | 'success';
type InstallTool = 'claude' | 'codex' | 'ollama';

interface OllamaCapability {
  enabled: boolean;
  ollamaReachable: boolean;
  ollamaUrl: string;
  platform: string;
  suggestedModel: string;
  installedModels: string[];
  totalRamBytes?: number;
}

export interface GuidedCreationResult {
  success: boolean;
  created: Model[];
  existing: Model[];
  error?: string;
}

export interface ModelConnectionWizardProps {
  open: boolean;
  onClose: () => void;
  onManualCreation: () => void;
  onCreateModels: (models: Model[]) => Promise<GuidedCreationResult>;
}

const drift = keyframes`
  0%, 100% { transform: translate3d(0, 0, 0) rotate(0deg); }
  50% { transform: translate3d(0, -9px, 0) rotate(5deg); }
`;

const arrive = keyframes`
  from { opacity: 0; transform: translate3d(18px, 0, 0) scale(.985); }
  to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
`;

const pop = keyframes`
  0% { transform: scale(.6) rotate(-12deg); opacity: 0; }
  70% { transform: scale(1.08) rotate(3deg); opacity: 1; }
  100% { transform: scale(1) rotate(0); opacity: 1; }
`;

const setupCopy: Record<Exclude<GuidedConnectionKind, 'ollama'>, {
  eyebrow: TranslationKey;
  title: TranslationKey;
  summary: TranslationKey;
  accountUrl?: string;
  accountLabel?: TranslationKey;
  keyLabel?: TranslationKey;
  note: TranslationKey;
}> = {
  'openrouter-free': {
    eyebrow: 'models.wizard.copy.freeOnline',
    title: 'models.wizard.openrouterFree.title',
    summary: 'models.wizard.openrouterFree.summary',
    accountUrl: 'https://openrouter.ai/settings/keys',
    accountLabel: 'models.wizard.openrouterFree.account',
    keyLabel: 'models.wizard.openrouterKey',
    note: 'models.wizard.openrouterFree.note',
  },
  'requesty-free': {
    eyebrow: 'models.wizard.copy.freeOnline',
    title: 'models.wizard.requestyFree.title',
    summary: 'models.wizard.requestyFree.summary',
    accountUrl: 'https://app.requesty.ai/api-keys',
    accountLabel: 'models.wizard.requestyFree.account',
    keyLabel: 'models.wizard.requestyKey',
    note: 'models.wizard.requestyFree.note',
  },
  'openrouter-paid': {
    eyebrow: 'models.wizard.copy.paygOnline',
    title: 'models.wizard.openrouterPaid.title',
    summary: 'models.wizard.openrouterPaid.summary',
    accountUrl: 'https://openrouter.ai/settings/keys',
    accountLabel: 'models.wizard.openrouterPaid.account',
    keyLabel: 'models.wizard.openrouterKey',
    note: 'models.wizard.openrouterPaid.note',
  },
  'requesty-paid': {
    eyebrow: 'models.wizard.copy.paygOnline',
    title: 'models.wizard.requestyPaid.title',
    summary: 'models.wizard.requestyPaid.summary',
    accountUrl: 'https://app.requesty.ai/api-keys',
    accountLabel: 'models.wizard.requestyPaid.account',
    keyLabel: 'models.wizard.requestyKey',
    note: 'models.wizard.requestyPaid.note',
  },
  'claude-subscription': {
    eyebrow: 'models.wizard.copy.claudeSubscription',
    title: 'models.wizard.claude.title',
    summary: 'models.wizard.claude.summary',
    keyLabel: 'models.wizard.claude.key',
    note: 'models.wizard.claude.note',
  },
  'codex-subscription': {
    eyebrow: 'models.wizard.copy.chatgptSubscription',
    title: 'models.wizard.codex.title',
    summary: 'models.wizard.codex.summary',
    note: 'models.wizard.codex.note',
  },
  'gemini-native': {
    eyebrow: 'models.wizard.copy.googleNative',
    title: 'models.wizard.gemini.title',
    summary: 'models.wizard.gemini.summary',
    accountUrl: 'https://aistudio.google.com/app/apikey',
    accountLabel: 'models.wizard.gemini.account',
    keyLabel: 'models.wizard.gemini.key',
    note: 'models.wizard.gemini.note',
  },
};

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
        minHeight: 132,
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
      {badge ? <Chip label={badge} size="small" color="primary" sx={{ position: 'absolute', top: 12, right: 12 }} /> : null}
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
      <Typography variant="subtitle1" sx={{ fontWeight: 720, pr: badge ? 7 : 0 }}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.45 }}>{description}</Typography>
    </Paper>
  );
}

function ChoiceGrid({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }}>
      {children}
    </Box>
  );
}

function CommandRow({ command, copied, onCopy }: { command: string; copied: boolean; onCopy: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderRadius: 2, bgcolor: alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.26 : 0.055) }}>
      <TerminalRoundedIcon fontSize="small" color="action" />
      <Typography component="code" variant="body2" sx={{ flex: 1, overflowWrap: 'anywhere', fontFamily: 'var(--font-geist-mono), ui-monospace, monospace' }}>
        {command}
      </Typography>
      <Tooltip title={copied ? t('models.wizard.copied') : t('models.wizard.copyCommand')}>
        <IconButton size="small" onClick={onCopy} aria-label={t('models.wizard.copyCommandAria', { command })}>
          {copied ? <CheckCircleRoundedIcon color="success" fontSize="small" /> : <ContentCopyRoundedIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Box>
  );
}

export default function ModelConnectionWizard({
  open,
  onClose,
  onManualCreation,
  onCreateModels,
}: ModelConnectionWizardProps) {
  const theme = useTheme();
  const { t, tp } = useI18n();
  const [step, setStep] = useState<WizardStep>('welcome');
  const [history, setHistory] = useState<WizardStep[]>([]);
  const [experience, setExperience] = useState<Experience>('beginner');
  const [kind, setKind] = useState<GuidedConnectionKind | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [confirmedLogin, setConfirmedLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Model[]>([]);
  const [existing, setExisting] = useState<Model[]>([]);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [installTool, setInstallTool] = useState<InstallTool | null>(null);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<'idle' | 'success' | 'error'>('idle');
  const [ollama, setOllama] = useState<OllamaCapability | null>(null);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaChecked, setOllamaChecked] = useState(false);
  const [ollamaPulling, setOllamaPulling] = useState(false);
  const [ollamaProgress, setOllamaProgress] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setStep('welcome');
    setHistory([]);
    setExperience('beginner');
    setKind(null);
    setApiKey('');
    setConfirmedLogin(false);
    setBusy(false);
    setError(null);
    setCreated([]);
    setExisting([]);
    setCopiedCommand(null);
    setInstallTool(null);
    setInstallOutput([]);
    setInstallResult('idle');
    setOllama(null);
    setOllamaChecked(false);
    setOllamaProgress([]);
  }, [open]);

  const go = (next: WizardStep) => {
    setHistory((value) => [...value, step]);
    setStep(next);
    setError(null);
  };

  const back = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((value) => value.slice(0, -1));
    setStep(previous);
    setError(null);
  };

  const selectSetup = (nextKind: GuidedConnectionKind) => {
    setKind(nextKind);
    go('setup');
  };

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(command);
      window.setTimeout(() => setCopiedCommand((value) => value === command ? null : value), 1600);
    } catch {
      setError(t('models.wizard.copyFailed'));
    }
  };

  const loadOllama = useCallback(async () => {
    setOllamaLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/local-models/capability', { cache: 'no-store' });
      if (!response.ok) throw new Error(t('models.wizard.inspectFailed'));
      setOllama(await response.json() as OllamaCapability);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('models.wizard.inspectFailed'));
    } finally {
      setOllamaChecked(true);
      setOllamaLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open && step === 'setup' && kind === 'ollama' && !ollamaChecked && !ollamaLoading) {
      void loadOllama();
    }
  }, [kind, loadOllama, ollamaChecked, ollamaLoading, open, step]);

  const runInstaller = async (tool: InstallTool) => {
    setInstallTool(tool);
    setInstallResult('idle');
    setInstallOutput([]);
    setError(null);
    try {
      const response = await fetch('/api/setup/ai-cli', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || t('models.wizard.installerStartFailed'));
      }
      let terminalSuccess = false;
      let terminalError = '';
      await readNdjsonStream(response, (event) => {
        if (event.type === 'stdout' || event.type === 'stderr') {
          setInstallOutput((lines) => [...lines, event.data].slice(-8));
        }
        if (event.type === 'status' && event.message) {
          setInstallOutput((lines) => [...lines, event.message!].slice(-8));
        }
        if (event.type === 'result') {
          terminalSuccess = event.success;
          terminalError = event.error || '';
        }
      });
      if (!terminalSuccess) throw new Error(terminalError || t('models.wizard.wingetFailed'));
      setInstallResult('success');
      if (tool === 'ollama') window.setTimeout(() => void loadOllama(), 1200);
    } catch (installError) {
      setInstallResult('error');
      setError(installError instanceof Error ? installError.message : t('models.wizard.installFailed'));
    } finally {
      setInstallTool(null);
    }
  };

  const finish = async (models: Model[]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await onCreateModels(models);
      if (!result.success) throw new Error(result.error || t('models.wizard.createFailed'));
      setCreated(result.created);
      setExisting(result.existing);
      go('success');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('models.wizard.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  const finishStandardSetup = async () => {
    if (!kind || kind === 'ollama') return;
    const requiresKey = kind !== 'codex-subscription';
    if (requiresKey && !apiKey.trim()) {
      setError(kind === 'claude-subscription'
        ? t('models.wizard.pasteClaudeToken')
        : t('models.wizard.pasteApiKey'));
      return;
    }
    if (kind === 'codex-subscription' && !confirmedLogin) {
      setError(t('models.wizard.confirmCodexLogin'));
      return;
    }
    await finish(buildGuidedModels({ kind, apiKey }));
  };

  const connectOllama = async () => {
    const modelName = ollama?.suggestedModel || 'llama3.2:3b';
    const alreadyInstalled = ollama?.installedModels?.some((name) => name === modelName);
    if (!ollama?.ollamaReachable) {
      setError(t('models.wizard.startOllama'));
      return;
    }

    if (!alreadyInstalled) {
      setOllamaPulling(true);
      setOllamaProgress([]);
      setError(null);
      try {
        const response = await fetch('/api/local-models/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelName }),
        });
        if (!response.ok) throw new Error(t('models.wizard.ollamaDownloadStartFailed'));
        let terminalSuccess = false;
        let terminalError = '';
        await readNdjsonStream(response, (event) => {
          if (event.type === 'stdout' || event.type === 'stderr') {
            setOllamaProgress((lines) => [...lines, event.data].slice(-6));
          }
          if (event.type === 'result') {
            terminalSuccess = event.success;
            terminalError = event.error || '';
          }
        });
        if (!terminalSuccess) throw new Error(terminalError || t('models.wizard.modelDownloadFailed', { model: modelName }));
      } catch (pullError) {
        setError(pullError instanceof Error ? pullError.message : t('models.wizard.downloadFailed'));
        setOllamaPulling(false);
        return;
      }
      setOllamaPulling(false);
    }

    await finish(buildGuidedModels({
      kind: 'ollama',
      ollamaModel: modelName,
      ollamaUrl: ollama?.ollamaUrl,
    }));
  };

  const verbose = experience === 'beginner';
  const progress = Math.min(96, step === 'welcome' ? 8 : step === 'success' ? 100 : 22 + history.length * 15);
  const setup = kind && kind !== 'ollama' ? setupCopy[kind] : null;
  const bundleNames = useMemo(() => kind ? guidedBundleNames(kind) : [], [kind]);
  const ollamaModel = ollama?.suggestedModel || 'llama3.2:3b';
  const ollamaInstalled = Boolean(ollama?.installedModels?.includes(ollamaModel));

  const installerPanel = (tool: InstallTool, installCommand: string, authCommand?: string) => (
    <Stack spacing={1.1}>
      <CommandRow command={installCommand} copied={copiedCommand === installCommand} onCopy={() => void copyCommand(installCommand)} />
      <Button
        variant="outlined"
        startIcon={installTool === tool ? <CircularProgress size={17} /> : <DownloadRoundedIcon />}
        disabled={Boolean(installTool)}
        onClick={() => void runInstaller(tool)}
        sx={{ alignSelf: 'flex-start' }}
      >
        {installTool === tool ? t('models.wizard.installing') : t('models.wizard.installWinget')}
      </Button>
      {authCommand ? (
        <CommandRow command={authCommand} copied={copiedCommand === authCommand} onCopy={() => void copyCommand(authCommand)} />
      ) : null}
      {installResult === 'success' ? <Alert severity="success">{t('models.wizard.installedContinue')}</Alert> : null}
      {installOutput.length ? (
        <Box component="pre" sx={{ m: 0, p: 1.4, maxHeight: 110, overflow: 'auto', borderRadius: 2, bgcolor: alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.3 : 0.06), color: 'text.secondary', whiteSpace: 'pre-wrap', fontSize: 11 }}>
          {installOutput.join('\n')}
        </Box>
      ) : null}
    </Stack>
  );

  const renderBody = () => {
    if (step === 'welcome') {
      return (
        <>
          <Chip icon={<AutoAwesomeRoundedIcon />} label={t('models.wizard.twoMinuteSetup')} color="primary" variant="outlined" sx={{ mb: 2 }} />
          <Typography variant="h4">{t('models.wizard.welcomeTitle')}</Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mt: 1, mb: 3, maxWidth: 680 }}>
            {t('models.wizard.welcomeQuestion')}
          </Typography>
          <ChoiceGrid>
            <OptionCard icon={SchoolRoundedIcon} title={t('models.wizard.noIdea')} description={t('models.wizard.noIdeaDescription')} badge={t('models.wizard.gentleGuide')} onClick={() => { setExperience('beginner'); go('budget'); }} />
            <OptionCard icon={BoltRoundedIcon} title={t('models.wizard.knowABit')} description={t('models.wizard.knowABitDescription')} onClick={() => { setExperience('familiar'); go('budget'); }} />
            <OptionCard icon={TuneRoundedIcon} title={t('models.wizard.expert')} description={t('models.wizard.expertDescription')} onClick={onManualCreation} />
          </ChoiceGrid>
        </>
      );
    }

    if (step === 'budget') {
      return (
        <>
          <Typography variant="overline" color="primary.main">{t('models.wizard.firstThings')}</Typography>
          <Typography variant="h4">{t('models.wizard.budgetTitle')}</Typography>
          {verbose ? (
            <Typography variant="body1" color="text.secondary" sx={{ mt: 1, mb: 3, maxWidth: 700 }}>
              {t('models.wizard.budgetVerbose')}
            </Typography>
          ) : <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>{t('models.wizard.budgetBrief')}</Typography>}
          <ChoiceGrid>
            <OptionCard icon={SavingsRoundedIcon} title={t('models.wizard.startFree')} description={t('models.wizard.startFreeDescription')} badge={t('models.wizard.startHere')} onClick={() => go('location')} />
            <OptionCard icon={WorkspacePremiumRoundedIcon} title={t('models.wizard.alreadySubscribe')} description={t('models.wizard.alreadySubscribeDescription')} onClick={() => go('subscription-provider')} />
            <OptionCard icon={CreditCardRoundedIcon} title={t('models.wizard.payNoSubscription')} description={t('models.wizard.payNoSubscriptionDescription')} onClick={() => go('paid-provider')} />
          </ChoiceGrid>
        </>
      );
    }

    if (step === 'location') {
      return (
        <>
          <Typography variant="overline" color="primary.main">{t('models.wizard.freeRoute')}</Typography>
          <Typography variant="h4">{t('models.wizard.locationTitle')}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>
            {verbose
              ? t('models.wizard.locationVerbose')
              : t('models.wizard.locationBrief')}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
            <OptionCard icon={CloudQueueRoundedIcon} title={t('models.wizard.online')} description={t('models.wizard.onlineDescription')} badge={t('models.wizard.easy')} onClick={() => go('free-provider')} />
            <OptionCard icon={ComputerRoundedIcon} title={t('models.wizard.offline')} description={t('models.wizard.offlineDescription')} badge={t('models.wizard.private')} onClick={() => selectSetup('ollama')} />
          </Box>
        </>
      );
    }

    if (step === 'free-provider') {
      return (
        <>
          <Typography variant="overline" color="primary.main">{t('models.wizard.copy.freeOnline')}</Typography>
          <Typography variant="h4">{t('models.wizard.chooseGateway')}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>
            {verbose ? t('models.wizard.freeGatewayVerbose') : t('models.wizard.freeGatewayBrief')}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
            <OptionCard icon={RocketLaunchRoundedIcon} title="OpenRouter" description={t('models.wizard.openrouterFreeDescription')} badge={t('models.wizard.recommended')} onClick={() => selectSetup('openrouter-free')} />
            <OptionCard icon={CloudQueueRoundedIcon} title="Requesty" description={t('models.wizard.requestyFreeDescription')} onClick={() => selectSetup('requesty-free')} />
          </Box>
        </>
      );
    }

    if (step === 'subscription-provider') {
      return (
        <>
          <Typography variant="overline" color="primary.main">{t('models.wizard.useExisting')}</Typography>
          <Typography variant="h4">{t('models.wizard.whichService')}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>
            {verbose ? t('models.wizard.subscriptionVerbose') : t('models.wizard.subscriptionBrief')}
          </Typography>
          <ChoiceGrid>
            <OptionCard icon={SmartToyRoundedIcon} title="Claude" description={t('models.wizard.claudeDescription')} onClick={() => selectSetup('claude-subscription')} />
            <OptionCard icon={TerminalRoundedIcon} title="ChatGPT / Codex" description={t('models.wizard.codexDescription')} badge={t('models.wizard.noKeyPaste')} onClick={() => selectSetup('codex-subscription')} />
            <OptionCard icon={AutoAwesomeRoundedIcon} title={t('models.wizard.geminiNative')} description={t('models.wizard.geminiDescription')} onClick={() => selectSetup('gemini-native')} />
          </ChoiceGrid>
        </>
      );
    }

    if (step === 'paid-provider') {
      return (
        <>
          <Typography variant="overline" color="primary.main">{t('models.wizard.payUsage')}</Typography>
          <Typography variant="h4">{t('models.wizard.chooseModelGateway')}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>
            {verbose ? t('models.wizard.paidVerbose') : t('models.wizard.paidBrief')}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
            <OptionCard icon={RocketLaunchRoundedIcon} title="OpenRouter" description={t('models.wizard.openrouterPaidDescription')} badge={t('models.wizard.recommended')} onClick={() => selectSetup('openrouter-paid')} />
            <OptionCard icon={CloudQueueRoundedIcon} title="Requesty" description={t('models.wizard.requestyPaidDescription')} onClick={() => selectSetup('requesty-paid')} />
          </Box>
        </>
      );
    }

    if (step === 'setup' && kind === 'ollama') {
      return (
        <>
          <Typography variant="overline" color="primary.main">{t('models.wizard.freeOffline')}</Typography>
          <Typography variant="h4">{t('models.wizard.ollamaTitle')}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 2.5 }}>
            {t('models.wizard.ollamaDescription')}
          </Typography>
          {ollamaLoading ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 3 }}><CircularProgress size={22} /><Typography>{t('models.wizard.checkingOllama')}</Typography></Box> : null}
          {!ollamaLoading && ollama ? (
            <Paper variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 3 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5}>
                <Box>
                  <Typography variant="subtitle1" sx={{ fontWeight: 720 }}>{t('models.wizard.recommendedModel', { model: ollamaModel })}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {ollama.ollamaReachable
                      ? ollamaInstalled ? t('models.wizard.ollamaInstalled') : t('models.wizard.ollamaCanDownload')
                      : t('models.wizard.ollamaNotRunningHelp')}
                  </Typography>
                </Box>
                <Chip color={ollama.ollamaReachable ? 'success' : 'warning'} label={ollama.ollamaReachable ? t('models.wizard.ollamaReady') : t('models.wizard.notRunning')} />
              </Stack>
            </Paper>
          ) : null}
          {!ollamaLoading && !ollama?.ollamaReachable ? (
            <Box sx={{ mb: 2 }}>
              {installerPanel('ollama', 'winget install --id Ollama.Ollama -e --source winget')}
              <Button startIcon={<RefreshRoundedIcon />} onClick={() => void loadOllama()} disabled={ollamaLoading || Boolean(installTool)} sx={{ mt: 1 }}>
                {t('models.wizard.checkAgain')}
              </Button>
            </Box>
          ) : null}
          {ollamaPulling ? (
            <Box sx={{ my: 2 }}>
              <LinearProgress />
              <Typography variant="body2" sx={{ mt: 1 }}>{t('models.wizard.downloading', { model: ollamaModel })}</Typography>
              {ollamaProgress.length ? <Typography component="pre" variant="caption" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>{ollamaProgress.join('\n')}</Typography> : null}
            </Box>
          ) : null}
          <Button
            variant="contained"
            size="large"
            startIcon={busy || ollamaPulling ? <CircularProgress size={18} color="inherit" /> : <DownloadRoundedIcon />}
            onClick={() => void connectOllama()}
            disabled={!ollama?.ollamaReachable || busy || ollamaPulling}
          >
            {ollamaInstalled ? t('models.wizard.connectModel', { model: ollamaModel }) : t('models.wizard.downloadConnect', { model: ollamaModel })}
          </Button>
        </>
      );
    }

    if (step === 'setup' && kind && setup) {
      const isClaude = kind === 'claude-subscription';
      const isCodex = kind === 'codex-subscription';
      return (
        <>
          <Typography variant="overline" color="primary.main">{t(setup.eyebrow)}</Typography>
          <Typography variant="h4">{t(setup.title)}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 2.2, maxWidth: 720 }}>{t(setup.summary)}</Typography>

          {isClaude ? (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>{t('models.wizard.installClaude')}</Typography>
              {installerPanel('claude', 'winget install --id Anthropic.ClaudeCode -e --source winget', 'claude setup-token')}
            </Box>
          ) : null}
          {isCodex ? (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>{t('models.wizard.installCodex')}</Typography>
              {installerPanel('codex', 'winget install --id OpenAI.Codex -e --source winget', 'codex login')}
              <FormControlLabel
                sx={{ mt: 1 }}
                control={<Checkbox checked={confirmedLogin} onChange={(event) => setConfirmedLogin(event.target.checked)} />}
                label={t('models.wizard.codexLoginComplete')}
              />
            </Box>
          ) : null}

          {setup.accountUrl ? (
            <Button href={setup.accountUrl} target="_blank" rel="noreferrer" variant="outlined" startIcon={<OpenInNewRoundedIcon />} sx={{ mb: 2 }}>
              {setup.accountLabel ? t(setup.accountLabel) : null}
            </Button>
          ) : null}

          {!isCodex ? (
            <TextField
              fullWidth
              type="password"
              autoComplete="off"
              label={`${isClaude ? '2. ' : ''}${setup.keyLabel ? t(setup.keyLabel) : ''}`}
              value={apiKey}
              onChange={(event) => { setApiKey(event.target.value); setError(null); }}
              InputProps={{ startAdornment: <KeyRoundedIcon color="action" sx={{ mr: 1 }} /> }}
              helperText={t('models.wizard.keyStorageHelp')}
              sx={{ mb: 2 }}
            />
          ) : null}

          <Alert severity="info" sx={{ mb: 2 }}>{t(setup.note)}</Alert>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>{t('models.wizard.willAdd')}</Typography>
          <Stack direction="row" gap={0.8} flexWrap="wrap" sx={{ mb: 2.5 }}>
            {bundleNames.map((name) => <Chip key={name} label={name} variant="outlined" />)}
          </Stack>
          <Button
            variant="contained"
            size="large"
            startIcon={busy ? <CircularProgress size={18} color="inherit" /> : <AutoAwesomeRoundedIcon />}
            onClick={() => void finishStandardSetup()}
            disabled={busy || Boolean(installTool)}
          >
            {tp('models.wizard.createModels', bundleNames.length)}
          </Button>
        </>
      );
    }

    if (step === 'success') {
      const allNames = [...created, ...existing].map((model) => model.displayName || model.name);
      return (
        <Box sx={{ textAlign: 'center', py: 2 }}>
          <Box sx={{ width: 78, height: 78, mx: 'auto', mb: 2, display: 'grid', placeItems: 'center', borderRadius: '50%', color: 'success.main', bgcolor: alpha(theme.palette.success.main, 0.13), animation: `${pop} 520ms cubic-bezier(.2,.8,.2,1) both` }}>
            <CheckCircleRoundedIcon sx={{ fontSize: 47 }} />
          </Box>
          <Typography variant="h4">{t('models.wizard.successTitle')}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 2.2 }}>
            {created.length ? tp('models.wizard.created', created.length) : t('models.wizard.alreadyMatched')}
            {existing.length ? ` ${tp('models.wizard.kept', existing.length)}` : ''}
          </Typography>
          <Stack direction="row" gap={0.8} justifyContent="center" flexWrap="wrap" sx={{ mb: 3 }}>
            {allNames.map((name) => <Chip icon={<SmartToyRoundedIcon />} key={name} label={name} color="primary" variant="outlined" />)}
          </Stack>
          <Button variant="contained" size="large" onClick={onClose}>{t('models.wizard.seeModels')}</Button>
        </Box>
      );
    }

    return null;
  };

  return (
    <Dialog open={open} onClose={busy || ollamaPulling || installTool ? undefined : onClose} fullWidth maxWidth="md" aria-label={t('models.wizard.aria')}>
      <DialogContent
        data-tour="ai-setup-wizard"
        sx={{ position: 'relative', minHeight: { xs: 560, sm: 590 }, p: { xs: 2.2, sm: 4 }, overflowX: 'hidden', overflowY: 'auto' }}
      >
        <Box aria-hidden sx={{ position: 'absolute', width: 220, height: 220, borderRadius: '50%', top: -120, right: -70, bgcolor: alpha(theme.palette.secondary.main, 0.12), filter: 'blur(1px)', animation: `${drift} 6s ease-in-out infinite` }} />
        <Box aria-hidden sx={{ position: 'absolute', width: 150, height: 150, borderRadius: 5, bottom: -100, left: -70, bgcolor: alpha(theme.palette.primary.main, 0.1), transform: 'rotate(24deg)', animation: `${drift} 7s ease-in-out -2s infinite` }} />

        <Box sx={{ position: 'relative', zIndex: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            {history.length && step !== 'success' ? (
              <IconButton onClick={back} aria-label={t('models.wizard.backAria')}><ArrowBackRoundedIcon /></IconButton>
            ) : <Box sx={{ width: 40 }} />}
            <Box sx={{ flex: 1 }}>
              <LinearProgress variant="determinate" value={progress} aria-label={t('models.wizard.progressAria')} />
            </Box>
            <IconButton onClick={onClose} aria-label={t('models.wizard.closeAria')} disabled={busy || ollamaPulling || Boolean(installTool)}><CloseRoundedIcon /></IconButton>
          </Box>

          {error ? <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 2 }}>{error}</Alert> : null}
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
