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
  eyebrow: string;
  title: string;
  summary: string;
  accountUrl?: string;
  accountLabel?: string;
  keyLabel?: string;
  note: string;
}> = {
  'openrouter-free': {
    eyebrow: 'Free · online',
    title: 'Meet your free AI router',
    summary: 'OpenRouter will pick an available zero-cost model for every request. It is ideal for learning and light use.',
    accountUrl: 'https://openrouter.ai/settings/keys',
    accountLabel: 'Create an OpenRouter key',
    keyLabel: 'OpenRouter API key',
    note: 'Free models have lower rate limits and can change as availability shifts. FLUJO creates the exact technical model openrouter/free.',
  },
  'requesty-free': {
    eyebrow: 'Free · online',
    title: 'Connect through Requesty',
    summary: 'Requesty gives you one gateway for many providers. This starter connection targets OpenRouter’s free router.',
    accountUrl: 'https://app.requesty.ai/api-keys',
    accountLabel: 'Create a Requesty key',
    keyLabel: 'Requesty API key',
    note: 'The target model is free, but Requesty account terms and routing limits still apply. Check the dashboard before heavier use.',
  },
  'openrouter-paid': {
    eyebrow: 'Pay as you go · online',
    title: 'One key, a useful starter team',
    summary: 'Add credits when you need them—no monthly subscription. FLUJO will create an automatic router, a cost-conscious model, and a high-capability model.',
    accountUrl: 'https://openrouter.ai/settings/keys',
    accountLabel: 'Open OpenRouter keys',
    keyLabel: 'OpenRouter API key',
    note: 'Provider usage is metered. Set a spending limit in OpenRouter before connecting if you want a hard ceiling.',
  },
  'requesty-paid': {
    eyebrow: 'Pay as you go · online',
    title: 'Route a starter team with Requesty',
    summary: 'Use a single funded account for DeepSeek, Claude, and OpenAI models, with Requesty handling the gateway.',
    accountUrl: 'https://app.requesty.ai/api-keys',
    accountLabel: 'Open Requesty keys',
    keyLabel: 'Requesty API key',
    note: 'Usage is billed through your Requesty account. Add budgets or policies in Requesty when you need tighter controls.',
  },
  'claude-subscription': {
    eyebrow: 'Existing subscription · Claude',
    title: 'Bring your Claude plan to FLUJO',
    summary: 'Claude Code signs in to your Pro or Max plan. One setup token powers four useful aliases in FLUJO.',
    keyLabel: 'Token from claude setup-token',
    note: 'The token is stored using FLUJO’s normal encrypted model-key storage. Your plan’s usage limits still apply.',
  },
  'codex-subscription': {
    eyebrow: 'Existing subscription · ChatGPT',
    title: 'Bring your ChatGPT plan through Codex',
    summary: 'Codex uses its local ChatGPT sign-in. FLUJO does not need your password or a copied browser token.',
    note: 'Run codex login in a terminal and complete the browser flow. FLUJO then creates a balanced Codex model set.',
  },
  'gemini-native': {
    eyebrow: 'Google · native SDK',
    title: 'Connect Gemini natively',
    summary: 'FLUJO talks directly to Google’s GenAI SDK and creates light, balanced, and pro Gemini choices.',
    accountUrl: 'https://aistudio.google.com/app/apikey',
    accountLabel: 'Create a Gemini API key',
    keyLabel: 'Gemini API key',
    note: 'A Gemini app subscription and Gemini API billing are separate products. The API key controls this connection.',
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
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderRadius: 2, bgcolor: alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.26 : 0.055) }}>
      <TerminalRoundedIcon fontSize="small" color="action" />
      <Typography component="code" variant="body2" sx={{ flex: 1, overflowWrap: 'anywhere', fontFamily: 'var(--font-geist-mono), ui-monospace, monospace' }}>
        {command}
      </Typography>
      <Tooltip title={copied ? 'Copied' : 'Copy command'}>
        <IconButton size="small" onClick={onCopy} aria-label={`Copy ${command}`}>
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
      setError('Could not copy automatically. Select the command and copy it manually.');
    }
  };

  const loadOllama = useCallback(async () => {
    setOllamaLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/local-models/capability', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not inspect this machine.');
      setOllama(await response.json() as OllamaCapability);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not inspect this machine.');
    } finally {
      setOllamaChecked(true);
      setOllamaLoading(false);
    }
  }, []);

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
        throw new Error(body.error || 'The installer could not be started.');
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
      if (!terminalSuccess) throw new Error(terminalError || 'WinGet did not finish successfully.');
      setInstallResult('success');
      if (tool === 'ollama') window.setTimeout(() => void loadOllama(), 1200);
    } catch (installError) {
      setInstallResult('error');
      setError(installError instanceof Error ? installError.message : 'Installation failed.');
    } finally {
      setInstallTool(null);
    }
  };

  const finish = async (models: Model[]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await onCreateModels(models);
      if (!result.success) throw new Error(result.error || 'FLUJO could not create the model connection.');
      setCreated(result.created);
      setExisting(result.existing);
      go('success');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'FLUJO could not create the model connection.');
    } finally {
      setBusy(false);
    }
  };

  const finishStandardSetup = async () => {
    if (!kind || kind === 'ollama') return;
    const requiresKey = kind !== 'codex-subscription';
    if (requiresKey && !apiKey.trim()) {
      setError(kind === 'claude-subscription'
        ? 'Paste the token produced by claude setup-token first.'
        : 'Paste your API key first.');
      return;
    }
    if (kind === 'codex-subscription' && !confirmedLogin) {
      setError('Confirm that codex login is complete before creating the models.');
      return;
    }
    await finish(buildGuidedModels({ kind, apiKey }));
  };

  const connectOllama = async () => {
    const modelName = ollama?.suggestedModel || 'llama3.2:3b';
    const alreadyInstalled = ollama?.installedModels?.some((name) => name === modelName);
    if (!ollama?.ollamaReachable) {
      setError('Start Ollama, then use “Check again” before downloading a model.');
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
        if (!response.ok) throw new Error('Ollama could not start the model download.');
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
        if (!terminalSuccess) throw new Error(terminalError || `Could not download ${modelName}.`);
      } catch (pullError) {
        setError(pullError instanceof Error ? pullError.message : 'The model download failed.');
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
        {installTool === tool ? 'Installing…' : 'Install with WinGet'}
      </Button>
      {authCommand ? (
        <CommandRow command={authCommand} copied={copiedCommand === authCommand} onCopy={() => void copyCommand(authCommand)} />
      ) : null}
      {installResult === 'success' ? <Alert severity="success">Installed. Continue with the sign-in command below.</Alert> : null}
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
          <Chip icon={<AutoAwesomeRoundedIcon />} label="A two-minute setup" color="primary" variant="outlined" sx={{ mb: 2 }} />
          <Typography variant="h4">Let’s connect your AI!</Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mt: 1, mb: 3, maxWidth: 680 }}>
            Do you already know how model providers, API keys, and local AI work?
          </Typography>
          <ChoiceGrid>
            <OptionCard icon={SchoolRoundedIcon} title="No idea" description="Explain the choices and guide me one small step at a time." badge="Gentle guide" onClick={() => { setExperience('beginner'); go('budget'); }} />
            <OptionCard icon={BoltRoundedIcon} title="I know a bit" description="Give me the important tradeoffs, then let me move quickly." onClick={() => { setExperience('familiar'); go('budget'); }} />
            <OptionCard icon={TuneRoundedIcon} title="I’m an expert" description="Skip the wizard and open every model setting." onClick={onManualCreation} />
          </ChoiceGrid>
        </>
      );
    }

    if (step === 'budget') {
      return (
        <>
          <Typography variant="overline" color="primary.main">First things first</Typography>
          <Typography variant="h4">How would you like to pay for AI?</Typography>
          {verbose ? (
            <Typography variant="body1" color="text.secondary" sx={{ mt: 1, mb: 3, maxWidth: 700 }}>
              Free services are great for learning but have tighter limits. A subscription reuses a plan you already have. Pay-as-you-go APIs charge only for what your flows use and are usually the most flexible.
            </Typography>
          ) : <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>Pick the billing style you want FLUJO to build around.</Typography>}
          <ChoiceGrid>
            <OptionCard icon={SavingsRoundedIcon} title="Let’s start free" description="No model usage bill; expect lower limits and changing availability." badge="Start here" onClick={() => go('location')} />
            <OptionCard icon={WorkspacePremiumRoundedIcon} title="I already subscribe" description="Use Claude, ChatGPT/Codex, or a native Gemini developer key." onClick={() => go('subscription-provider')} />
            <OptionCard icon={CreditCardRoundedIcon} title="I can pay—no subscription" description="Fund an API account and pay only for the requests you make." onClick={() => go('paid-provider')} />
          </ChoiceGrid>
        </>
      );
    }

    if (step === 'location') {
      return (
        <>
          <Typography variant="overline" color="primary.main">Free route</Typography>
          <Typography variant="h4">Online or offline?</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>
            {verbose
              ? 'Online is easier and uses someone else’s hardware. Offline keeps prompts on this machine but downloads a model and uses your RAM or GPU.'
              : 'Online is quickest; offline is private and uses this computer.'}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
            <OptionCard icon={CloudQueueRoundedIcon} title="Online" description="Fastest setup. Create a provider account and an API key." badge="Easy" onClick={() => go('free-provider')} />
            <OptionCard icon={ComputerRoundedIcon} title="Offline" description="Install Ollama and download a model sized for this computer." badge="Private" onClick={() => selectSetup('ollama')} />
          </Box>
        </>
      );
    }

    if (step === 'free-provider') {
      return (
        <>
          <Typography variant="overline" color="primary.main">Free · online</Typography>
          <Typography variant="h4">Choose your gateway</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>
            {verbose ? 'Both use the same free-router target; OpenRouter is the most direct route.' : 'OpenRouter is the direct route; Requesty adds gateway features.'}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
            <OptionCard icon={RocketLaunchRoundedIcon} title="OpenRouter" description="Direct access to openrouter/free, with no model charges." badge="Recommended" onClick={() => selectSetup('openrouter-free')} />
            <OptionCard icon={CloudQueueRoundedIcon} title="Requesty" description="A unified gateway that can grow into policies and paid models later." onClick={() => selectSetup('requesty-free')} />
          </Box>
        </>
      );
    }

    if (step === 'subscription-provider') {
      return (
        <>
          <Typography variant="overline" color="primary.main">Use what you already have</Typography>
          <Typography variant="h4">Which service are you connecting?</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>
            {verbose ? 'FLUJO will create a ready-to-use bundle, not just one empty model record.' : 'Pick the account you already use.'}
          </Typography>
          <ChoiceGrid>
            <OptionCard icon={SmartToyRoundedIcon} title="Claude" description="Use a Claude Pro or Max plan through Claude Code." onClick={() => selectSetup('claude-subscription')} />
            <OptionCard icon={TerminalRoundedIcon} title="ChatGPT / Codex" description="Use the local Codex sign-in attached to your ChatGPT plan." badge="No key paste" onClick={() => selectSetup('codex-subscription')} />
            <OptionCard icon={AutoAwesomeRoundedIcon} title="Gemini Native" description="Use Google’s native GenAI SDK with a Gemini developer key." onClick={() => selectSetup('gemini-native')} />
          </ChoiceGrid>
        </>
      );
    }

    if (step === 'paid-provider') {
      return (
        <>
          <Typography variant="overline" color="primary.main">Pay only for usage</Typography>
          <Typography variant="h4">Choose your model gateway</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>
            {verbose ? 'You fund one account, and FLUJO creates several model choices that share its encrypted key.' : 'Both gateways share one encrypted key across the starter bundle.'}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
            <OptionCard icon={RocketLaunchRoundedIcon} title="OpenRouter" description="Broad model catalog with direct auto-routing and spending limits." badge="Recommended" onClick={() => selectSetup('openrouter-paid')} />
            <OptionCard icon={CloudQueueRoundedIcon} title="Requesty" description="Unified routing with policies, observability, and provider fallbacks." onClick={() => selectSetup('requesty-paid')} />
          </Box>
        </>
      );
    }

    if (step === 'setup' && kind === 'ollama') {
      return (
        <>
          <Typography variant="overline" color="primary.main">Free · offline</Typography>
          <Typography variant="h4">Make this computer the AI provider</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 2.5 }}>
            Ollama runs the model locally. The first model download can be several gigabytes; after that, prompts stay on this machine.
          </Typography>
          {ollamaLoading ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 3 }}><CircularProgress size={22} /><Typography>Checking Ollama and this machine…</Typography></Box> : null}
          {!ollamaLoading && ollama ? (
            <Paper variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 3 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5}>
                <Box>
                  <Typography variant="subtitle1" sx={{ fontWeight: 720 }}>Recommended: {ollamaModel}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {ollama.ollamaReachable
                      ? ollamaInstalled ? 'Ollama is ready and this model is already downloaded.' : 'Ollama is ready. FLUJO can download this model now.'
                      : 'Ollama is not running yet. Install or start it, then check again.'}
                  </Typography>
                </Box>
                <Chip color={ollama.ollamaReachable ? 'success' : 'warning'} label={ollama.ollamaReachable ? 'Ollama ready' : 'Not running'} />
              </Stack>
            </Paper>
          ) : null}
          {!ollamaLoading && !ollama?.ollamaReachable ? (
            <Box sx={{ mb: 2 }}>
              {installerPanel('ollama', 'winget install --id Ollama.Ollama -e --source winget')}
              <Button startIcon={<RefreshRoundedIcon />} onClick={() => void loadOllama()} disabled={ollamaLoading || Boolean(installTool)} sx={{ mt: 1 }}>
                Check again
              </Button>
            </Box>
          ) : null}
          {ollamaPulling ? (
            <Box sx={{ my: 2 }}>
              <LinearProgress />
              <Typography variant="body2" sx={{ mt: 1 }}>Downloading {ollamaModel}… keep FLUJO open.</Typography>
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
            {ollamaInstalled ? `Connect ${ollamaModel}` : `Download ${ollamaModel} & connect`}
          </Button>
        </>
      );
    }

    if (step === 'setup' && kind && setup) {
      const isClaude = kind === 'claude-subscription';
      const isCodex = kind === 'codex-subscription';
      return (
        <>
          <Typography variant="overline" color="primary.main">{setup.eyebrow}</Typography>
          <Typography variant="h4">{setup.title}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 2.2, maxWidth: 720 }}>{setup.summary}</Typography>

          {isClaude ? (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>1. Install Claude Code, then create a setup token</Typography>
              {installerPanel('claude', 'winget install --id Anthropic.ClaudeCode -e --source winget', 'claude setup-token')}
            </Box>
          ) : null}
          {isCodex ? (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>1. Install Codex, then sign in with ChatGPT</Typography>
              {installerPanel('codex', 'winget install --id OpenAI.Codex -e --source winget', 'codex login')}
              <FormControlLabel
                sx={{ mt: 1 }}
                control={<Checkbox checked={confirmedLogin} onChange={(event) => setConfirmedLogin(event.target.checked)} />}
                label="I completed the Codex browser sign-in"
              />
            </Box>
          ) : null}

          {setup.accountUrl ? (
            <Button href={setup.accountUrl} target="_blank" rel="noreferrer" variant="outlined" startIcon={<OpenInNewRoundedIcon />} sx={{ mb: 2 }}>
              {setup.accountLabel}
            </Button>
          ) : null}

          {!isCodex ? (
            <TextField
              fullWidth
              type="password"
              autoComplete="off"
              label={`${isClaude ? '2. ' : ''}${setup.keyLabel}`}
              value={apiKey}
              onChange={(event) => { setApiKey(event.target.value); setError(null); }}
              InputProps={{ startAdornment: <KeyRoundedIcon color="action" sx={{ mr: 1 }} /> }}
              helperText="Saved only when you finish; FLUJO encrypts it through the existing model-storage path."
              sx={{ mb: 2 }}
            />
          ) : null}

          <Alert severity="info" sx={{ mb: 2 }}>{setup.note}</Alert>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>FLUJO will add</Typography>
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
            Create {bundleNames.length === 1 ? 'my model' : `my ${bundleNames.length} models`}
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
          <Typography variant="h4">Your AI is ready to flow</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, mb: 2.2 }}>
            {created.length ? `${created.length} new connection${created.length === 1 ? '' : 's'} created.` : 'Your matching connections were already here.'}
            {existing.length ? ` ${existing.length} existing connection${existing.length === 1 ? ' was' : 's were'} kept.` : ''}
          </Typography>
          <Stack direction="row" gap={0.8} justifyContent="center" flexWrap="wrap" sx={{ mb: 3 }}>
            {allNames.map((name) => <Chip icon={<SmartToyRoundedIcon />} key={name} label={name} color="primary" variant="outlined" />)}
          </Stack>
          <Button variant="contained" size="large" onClick={onClose}>See my models</Button>
        </Box>
      );
    }

    return null;
  };

  return (
    <Dialog open={open} onClose={busy || ollamaPulling || installTool ? undefined : onClose} fullWidth maxWidth="md" aria-label="Connect AI setup wizard">
      <DialogContent sx={{ position: 'relative', minHeight: { xs: 560, sm: 590 }, p: { xs: 2.2, sm: 4 }, overflowX: 'hidden', overflowY: 'auto' }}>
        <Box aria-hidden sx={{ position: 'absolute', width: 220, height: 220, borderRadius: '50%', top: -120, right: -70, bgcolor: alpha(theme.palette.secondary.main, 0.12), filter: 'blur(1px)', animation: `${drift} 6s ease-in-out infinite` }} />
        <Box aria-hidden sx={{ position: 'absolute', width: 150, height: 150, borderRadius: 5, bottom: -100, left: -70, bgcolor: alpha(theme.palette.primary.main, 0.1), transform: 'rotate(24deg)', animation: `${drift} 7s ease-in-out -2s infinite` }} />

        <Box sx={{ position: 'relative', zIndex: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            {history.length && step !== 'success' ? (
              <IconButton onClick={back} aria-label="Back"><ArrowBackRoundedIcon /></IconButton>
            ) : <Box sx={{ width: 40 }} />}
            <Box sx={{ flex: 1 }}>
              <LinearProgress variant="determinate" value={progress} aria-label="Connection progress" />
            </Box>
            <IconButton onClick={onClose} aria-label="Close connection wizard" disabled={busy || ollamaPulling || Boolean(installTool)}><CloseRoundedIcon /></IconButton>
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
