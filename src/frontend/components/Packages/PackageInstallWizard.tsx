'use client';

// PackageInstallWizard (issue #407)
// -----------------------------------------------------------------------------
// The wizard-style replacement for the old two-screen install dialog. It models
// the same shell as the package-creation `PackageWizard` (MUI Stepper + Back /
// Next / final action) and walks the user through:
//
//   models -> apps & servers -> flows & triggers -> rename -> secrets -> review
//   -> per-entity result
//
// Steps that a package does not need are skipped entirely, so a tiny package is
// still a two-click install. Nothing is written to the host until the final
// "Install package" action: everything before it is the existing side-effect
// free dry-run (`consentGranted: false`), so Back and Cancel are always safe.
//
// Secrets posture: secret values live in this component's ephemeral state and
// in the install request only. They are never echoed into the summary, the
// ledger, logs or persisted browser storage.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Link,
  MenuItem,
  Paper,
  Step,
  StepLabel,
  Stepper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import PackageFlowPreview from '@/frontend/components/Packages/PackageFlowPreview';
import { packageService, type InstallSummary } from '@/frontend/services/packages';
import type {
  InstallStep,
  InstallStepStatus,
  PackageDeclarationInfo,
} from '@/backend/services/packages/installPackage';
import {
  buildRenamePreview,
  validateRenameMap,
  type RenameCandidate,
  type RenameMode,
  type RenameRule,
} from '@/utils/shared/packageRename';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/Packages/PackageInstallWizard');

type StepKey = 'models' | 'apps' | 'browse' | 'rename' | 'secrets' | 'review';
type RenameKind = 'flows' | 'plannedExecutions';

export interface PackageInstallWizardProps {
  open: boolean;
  /** Registry package id, e.g. `@publisher/name`. */
  packageId: string;
  packageName: string;
  version?: string;
  onClose: () => void;
  onInstalled?: () => void;
}

const STATUS_ICON: Record<InstallStepStatus, ReactNode> = {
  ok: <CheckCircleRoundedIcon color="success" fontSize="small" />,
  created: <CheckCircleRoundedIcon color="success" fontSize="small" />,
  updated: <CheckCircleRoundedIcon color="success" fontSize="small" />,
  adopted: <CheckCircleRoundedIcon color="info" fontSize="small" />,
  skipped: <RemoveCircleOutlineIcon color="disabled" fontSize="small" />,
  disabled: <PauseCircleOutlineIcon color="warning" fontSize="small" />,
  failed: <ErrorOutlineRoundedIcon color="error" fontSize="small" />,
};

/** Literal message keys (a template string would defeat the typed catalog). */
const STATUS_LABEL_KEY = {
  ok: 'packages.install.status.ok',
  created: 'packages.install.status.created',
  updated: 'packages.install.status.updated',
  adopted: 'packages.install.status.adopted',
  skipped: 'packages.install.status.skipped',
  disabled: 'packages.install.status.disabled',
  failed: 'packages.install.status.failed',
} as const;

export default function PackageInstallWizard({
  open,
  packageId,
  packageName,
  version,
  onClose,
  onInstalled,
}: PackageInstallWizardProps) {
  const { t, tp, formatNumber, formatList } = useI18n();

  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<InstallSummary | null>(null);
  const [result, setResult] = useState<InstallSummary | null>(null);
  const [activeStep, setActiveStep] = useState(0);

  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [globalValues, setGlobalValues] = useState<Record<string, string>>({});
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});
  const [modelMappings, setModelMappings] = useState<Record<string, string>>({});
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [showInstalledModels, setShowInstalledModels] = useState(false);
  const [filter, setFilter] = useState('');
  const [expandedFlow, setExpandedFlow] = useState<string | null>(null);

  const [renameRules, setRenameRules] = useState<Record<RenameKind, RenameRule>>({
    flows: { mode: 'none' },
    plannedExecutions: { mode: 'none' },
  });
  const [renameOverrides, setRenameOverrides] = useState<Record<RenameKind, Record<string, string>>>({
    flows: {},
    plannedExecutions: {},
  });

  const stepPanelRef = useRef<HTMLDivElement | null>(null);

  const manifest = preview?.preview;
  const models = manifest?.models ?? [];
  const installedModels = manifest?.installedModels ?? [];
  const servers = useMemo(() => manifest?.serverDetails ?? [], [manifest]);
  const flows = useMemo(() => manifest?.flowDetails ?? [], [manifest]);
  const triggers = useMemo(() => manifest?.triggerDetails ?? [], [manifest]);
  const secrets = useMemo(
    () =>
      manifest?.secretDetails ??
      (manifest?.secrets ?? []).map((s) => ({
        key: s.key,
        description: s.label,
        required: s.required,
        provided: s.provided,
        usedBy: [] as Array<{ type: string; name: string }>,
      })),
    [manifest],
  );
  const globals = useMemo(
    () =>
      manifest?.globalDetails ??
      (manifest?.globals ?? []).map((g) => ({
        name: g.name,
        description: g.description,
        required: g.required,
        isSecret: g.isSecret === true,
        present: !(manifest?.missingGlobals ?? []).includes(g.name),
        usedBy: [] as Array<{ type: string; name: string }>,
      })),
    [manifest],
  );

  // --- load the side-effect free preview ------------------------------------
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);
    setResult(null);
    setActiveStep(0);
    setSecretValues({});
    setGlobalValues({});
    setVisibleSecrets({});
    setModelMappings({});
    setActiveModelId(null);
    setShowInstalledModels(false);
    setFilter('');
    setExpandedFlow(null);
    setRenameRules({ flows: { mode: 'none' }, plannedExecutions: { mode: 'none' } });
    setRenameOverrides({ flows: {}, plannedExecutions: {} });

    void packageService
      .installFromRegistry({ packageId, ...(version ? { version } : {}), consentGranted: false })
      .then((summary) => {
        if (cancelled) return;
        if (!summary.ok) {
          setError(summary.errors?.[0] || t('packages.browse.previewFailed'));
          return;
        }
        setPreview(summary);
        setActiveModelId(summary.preview?.models?.[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        log.warn('Failed to fetch package preview', err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, packageId, version, t]);

  // --- bulk renames (pure, shared with the backend) --------------------------
  const flowCandidates: RenameCandidate[] = useMemo(
    () => flows.map((f) => ({ key: f.localId, original: f.name, kind: 'flow' as const })),
    [flows],
  );
  const triggerCandidates: RenameCandidate[] = useMemo(
    () => triggers.map((tr) => ({ key: tr.key, original: tr.name, kind: 'plannedExecution' as const })),
    [triggers],
  );

  const renameState = useMemo(() => {
    const build = (candidates: RenameCandidate[], kind: RenameKind) => {
      const rulePreview = buildRenamePreview(candidates, renameRules[kind]);
      const names: Record<string, string> = {};
      for (const item of rulePreview.items) {
        const override = renameOverrides[kind][item.key];
        names[item.key] = typeof override === 'string' ? override : item.renamed;
      }
      const map: Record<string, string> = {};
      for (const candidate of candidates) {
        if (names[candidate.key] !== undefined && names[candidate.key] !== candidate.original) {
          map[candidate.key] = names[candidate.key];
        }
      }
      const errors = validateRenameMap(map, candidates, { label: kind === 'flows' ? 'flow' : 'trigger' });
      return { rulePreview, names, map, errors };
    };
    return {
      flows: build(flowCandidates, 'flows'),
      plannedExecutions: build(triggerCandidates, 'plannedExecutions'),
    };
  }, [flowCandidates, triggerCandidates, renameRules, renameOverrides]);

  const renameMaps = useMemo(
    () => ({
      flows: renameState.flows.map,
      plannedExecutions: renameState.plannedExecutions.map,
    }),
    [renameState],
  );
  const renameErrors = useMemo(
    () => [
      ...(renameState.flows.rulePreview.ruleError ? [renameState.flows.rulePreview.ruleError] : []),
      ...(renameState.plannedExecutions.rulePreview.ruleError
        ? [renameState.plannedExecutions.rulePreview.ruleError]
        : []),
      ...renameState.flows.errors,
      ...renameState.plannedExecutions.errors,
      ...(manifest?.renameErrors ?? []),
    ],
    [renameState, manifest],
  );

  // --- step model ------------------------------------------------------------
  const steps = useMemo(() => {
    const list: Array<{ key: StepKey; label: string }> = [];
    if (models.length > 0) list.push({ key: 'models', label: t('packages.install.matchModels') });
    if (servers.length > 0) list.push({ key: 'apps', label: t('packages.install.stepApps') });
    if (flows.length > 0 || triggers.length > 0) {
      list.push({ key: 'browse', label: t('packages.install.stepBrowse') });
      list.push({ key: 'rename', label: t('packages.install.stepRename') });
    }
    if (secrets.length > 0 || globals.length > 0) {
      list.push({ key: 'secrets', label: t('packages.install.stepSecrets') });
    }
    list.push({ key: 'review', label: t('packages.install.reviewInstall') });
    return list;
  }, [models.length, servers.length, flows.length, triggers.length, secrets.length, globals.length, t]);

  const currentStep = steps[Math.min(activeStep, steps.length - 1)]?.key ?? 'review';

  // Move keyboard focus to the step panel whenever the step changes, so the
  // wizard stays navigable without a mouse.
  useEffect(() => {
    if (!preview || result) return;
    stepPanelRef.current?.focus();
  }, [activeStep, preview, result]);

  const allModelsResolved = models.every((m) =>
    Object.prototype.hasOwnProperty.call(modelMappings, m.id),
  );
  const nextDisabled =
    (currentStep === 'models' && !allModelsResolved) ||
    (currentStep === 'rename' && renameErrors.length > 0);

  const install = useCallback(async () => {
    if (!preview) return;
    setInstalling(true);
    setError(null);
    try {
      const variables = Object.fromEntries(
        globals
          .map(
            (global) =>
              [
                global.name,
                {
                  value: globalValues[global.name]?.trim() ?? '',
                  metadata: { isSecret: global.isSecret === true },
                },
              ] as const,
          )
          .filter(([, entry]) => entry.value.length > 0),
      );
      if (Object.keys(variables).length > 0) {
        const envResponse = await fetch('/api/env', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'setAll', variables }),
        });
        if (!envResponse.ok) {
          const body = await envResponse.json().catch(() => ({}));
          throw new Error(body?.error || t('packages.browse.globalsFailed', { status: envResponse.status }));
        }
      }
      const summary = await packageService.installFromRegistry({
        packageId,
        ...(version ? { version } : {}),
        secrets: secretValues,
        modelMappings: Object.fromEntries(Object.entries(modelMappings).filter(([, id]) => id !== '')),
        renames: renameMaps,
        consentGranted: true,
      });
      setResult(summary);
      setPreview(null);
      if (summary.ok) onInstalled?.();
    } catch (err) {
      log.warn('Install failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }, [preview, globals, globalValues, packageId, version, secretValues, modelMappings, renameMaps, onInstalled, t]);

  const busy = loading || installing;

  // --- renderers -------------------------------------------------------------

  const renderDeclaration = (declaration: PackageDeclarationInfo) => (
    <Stack key={declaration.name} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
      <Typography variant="body2" fontFamily="monospace">{declaration.name}</Typography>
      {declaration.isSecret && <Chip size="small" color="warning" variant="outlined" label={t('packages.install.secretTag')} />}
      <Typography variant="caption" color="text.secondary">
        {declaration.source === 'secret'
          ? t('packages.install.fromSecret', { name: declaration.secretRef ?? '' })
          : declaration.source === 'global'
            ? t('packages.install.fromGlobal', { name: declaration.globalVar ?? '' })
            : t('packages.install.fromEnvironment')}
      </Typography>
      {declaration.required && !declaration.provided && declaration.source === 'secret' && (
        <Chip size="small" color="error" variant="outlined" label={t('packages.install.required')} />
      )}
    </Stack>
  );

  const renderAppsStep = () => {
    const term = filter.trim().toLocaleLowerCase();
    const visible = term
      ? servers.filter((s) => `${s.localName} ${s.source}`.toLocaleLowerCase().includes(term))
      : servers;
    return (
      <Box>
        <Typography variant="h6" gutterBottom>{t('packages.install.appsTitle')}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('packages.install.appsHelp')}
        </Typography>
        {servers.length > 5 && (
          <TextField
            size="small"
            fullWidth
            sx={{ mb: 2 }}
            label={t('packages.install.filter')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
        <Stack spacing={2}>
          {visible.map((server) => (
            <Paper key={server.localName} variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Typography variant="subtitle1" fontWeight={700}>{server.localName}</Typography>
                <Chip size="small" label={server.transport} />
                <Chip size="small" variant="outlined" label={server.sourceType} />
                {server.disabled && (
                  <Chip size="small" color="warning" variant="outlined" label={t('packages.install.shippedDisabled')} />
                )}
                {server.link && (
                  <Link
                    href={server.link}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    variant="caption"
                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
                  >
                    {t('packages.install.viewSource')}
                    <OpenInNewIcon sx={{ fontSize: 14 }} />
                  </Link>
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                {server.source}
              </Typography>

              {(server.installCommand || server.buildCommand) && (
                <Box sx={{ mt: 1.5 }}>
                  <Alert severity="warning" sx={{ mb: 1 }}>{t('packages.install.commandWarning')}</Alert>
                  {server.installCommand && (
                    <Box sx={{ mb: 0.5 }}>
                      <Typography variant="caption" color="text.secondary">{t('packages.install.installCommand')}</Typography>
                      <Typography variant="body2" fontFamily="monospace">{server.installCommand}</Typography>
                    </Box>
                  )}
                  {server.buildCommand && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">{t('packages.install.buildCommand')}</Typography>
                      <Typography variant="body2" fontFamily="monospace">{server.buildCommand}</Typography>
                    </Box>
                  )}
                </Box>
              )}

              {server.argTemplates.length > 0 && (
                <Box sx={{ mt: 1.5 }}>
                  <Typography variant="caption" color="text.secondary">{t('packages.install.arguments')}</Typography>
                  <Typography variant="body2" fontFamily="monospace">
                    {server.argTemplates.map((a) => a.value).join(' ')}
                  </Typography>
                </Box>
              )}

              {server.env.length > 0 && (
                <Box sx={{ mt: 1.5 }}>
                  <Typography variant="caption" color="text.secondary">{t('packages.install.envVars')}</Typography>
                  <Stack spacing={0.5} sx={{ mt: 0.5 }}>{server.env.map(renderDeclaration)}</Stack>
                </Box>
              )}
              {server.headers.length > 0 && (
                <Box sx={{ mt: 1.5 }}>
                  <Typography variant="caption" color="text.secondary">{t('packages.install.headers')}</Typography>
                  <Stack spacing={0.5} sx={{ mt: 0.5 }}>{server.headers.map(renderDeclaration)}</Stack>
                </Box>
              )}

              {server.requiredEnvMissing.length > 0 && (
                <Alert severity="warning" sx={{ mt: 1.5 }}>
                  {t('packages.install.serverWillDisable', { names: formatList(server.requiredEnvMissing) })}
                </Alert>
              )}
            </Paper>
          ))}
        </Stack>
      </Box>
    );
  };

  const renderBrowseStep = () => (
    <Box>
      <Typography variant="h6" gutterBottom>{t('packages.install.browseTitle')}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('packages.install.browseHelp')}
      </Typography>

      {flows.length === 0 && (
        <Typography variant="body2" color="text.secondary">{t('packages.install.noFlows')}</Typography>
      )}
      <Stack spacing={1.5}>
        {flows.map((flow) => {
          const expanded = expandedFlow === flow.localId;
          return (
            <Paper key={flow.localId} variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="subtitle1" fontWeight={700} noWrap>
                    {renameState.flows.names[flow.localId] ?? flow.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t('packages.install.nodesEdges', {
                      nodes: formatNumber(flow.nodeCount),
                      edges: formatNumber(flow.edgeCount),
                    })}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  onClick={() => setExpandedFlow(expanded ? null : flow.localId)}
                  aria-expanded={expanded}
                >
                  {expanded ? t('packages.install.hide') : t('packages.install.inspect')}
                </Button>
              </Stack>
              {expanded && (
                <Box sx={{ mt: 1.5 }}>
                  <PackageFlowPreview flow={flow} />
                </Box>
              )}
            </Paper>
          );
        })}
      </Stack>

      <Divider sx={{ my: 2.5 }} />
      <Typography variant="subtitle1" fontWeight={700} gutterBottom>
        {t('packages.install.triggersTitle')}
      </Typography>
      {triggers.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{t('packages.install.noTriggers')}</Typography>
      ) : (
        <Stack spacing={1.5}>
          {triggers.map((trigger) => (
            <Paper key={trigger.key} variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Typography variant="subtitle2" fontWeight={700}>
                  {renameState.plannedExecutions.names[trigger.key] ?? trigger.name}
                </Typography>
                <Chip size="small" label={trigger.triggerType} />
                <Chip size="small" color="warning" variant="outlined" label={t('packages.install.triggerDisabled')} />
              </Stack>
              {trigger.flowName && (
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                  {t('packages.install.runsFlow', { name: trigger.flowName })}
                </Typography>
              )}
              {trigger.details.length > 0 && (
                <Stack spacing={0.25} sx={{ mt: 1 }}>
                  {trigger.details.map((detail) => (
                    <Typography key={detail.label} variant="caption" color="text.secondary">
                      {detail.label}: <Box component="span" fontFamily="monospace">{detail.value}</Box>
                    </Typography>
                  ))}
                </Stack>
              )}
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );

  const renderRenameGroup = (
    kind: RenameKind,
    title: string,
    candidates: RenameCandidate[],
  ) => {
    if (candidates.length === 0) return null;
    const rule = renameRules[kind];
    const state = renameState[kind];
    return (
      <Box sx={{ mb: 3 }}>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>{title}</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 1.5 }}>
          <TextField
            select
            size="small"
            label={t('packages.install.renameMode')}
            value={rule.mode}
            onChange={(e) =>
              setRenameRules((current) => ({
                ...current,
                [kind]: { ...current[kind], mode: e.target.value as RenameMode },
              }))
            }
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="none">{t('packages.install.renameNone')}</MenuItem>
            <MenuItem value="prefix">{t('packages.install.renamePrefix')}</MenuItem>
            <MenuItem value="suffix">{t('packages.install.renameSuffix')}</MenuItem>
            <MenuItem value="regex">{t('packages.install.renameRegex')}</MenuItem>
          </TextField>

          {rule.mode === 'prefix' && (
            <TextField
              size="small"
              label={t('packages.install.renamePrefix')}
              value={rule.prefix ?? ''}
              onChange={(e) =>
                setRenameRules((current) => ({ ...current, [kind]: { ...current[kind], prefix: e.target.value } }))
              }
            />
          )}
          {rule.mode === 'suffix' && (
            <TextField
              size="small"
              label={t('packages.install.renameSuffix')}
              value={rule.suffix ?? ''}
              onChange={(e) =>
                setRenameRules((current) => ({ ...current, [kind]: { ...current[kind], suffix: e.target.value } }))
              }
            />
          )}
          {rule.mode === 'regex' && (
            <>
              <TextField
                size="small"
                label={t('packages.install.renameFind')}
                value={rule.pattern ?? ''}
                error={Boolean(state.rulePreview.ruleError)}
                helperText={state.rulePreview.ruleError ?? ' '}
                onChange={(e) =>
                  setRenameRules((current) => ({ ...current, [kind]: { ...current[kind], pattern: e.target.value } }))
                }
              />
              <TextField
                size="small"
                label={t('packages.install.renameReplace')}
                value={rule.replacement ?? ''}
                onChange={(e) =>
                  setRenameRules((current) => ({
                    ...current,
                    [kind]: { ...current[kind], replacement: e.target.value },
                  }))
                }
              />
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={rule.caseInsensitive === true}
                    onChange={(e) =>
                      setRenameRules((current) => ({
                        ...current,
                        [kind]: { ...current[kind], caseInsensitive: e.target.checked },
                      }))
                    }
                  />
                }
                label={t('packages.install.renameCaseInsensitive')}
              />
            </>
          )}
        </Stack>

        <Stack spacing={1}>
          {candidates.map((candidate) => {
            const item = state.rulePreview.items.find((i) => i.key === candidate.key);
            const value = state.names[candidate.key] ?? candidate.original;
            const itemError =
              value.trim() === ''
                ? t('packages.install.renameBlank')
                : state.errors.find((e) => e.includes(`"${candidate.original}"`) || e.includes(`"${value}"`));
            return (
              <Stack
                key={candidate.key}
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems={{ sm: 'center' }}
              >
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ minWidth: { sm: 220 }, textDecoration: item?.changed ? 'line-through' : 'none' }}
                >
                  {candidate.original}
                </Typography>
                <TextField
                  size="small"
                  fullWidth
                  label={t('packages.install.renameNew')}
                  value={value}
                  error={Boolean(itemError)}
                  helperText={itemError ?? ' '}
                  inputProps={{ 'aria-label': t('packages.install.renameAria', { name: candidate.original }) }}
                  onChange={(e) =>
                    setRenameOverrides((current) => ({
                      ...current,
                      [kind]: { ...current[kind], [candidate.key]: e.target.value },
                    }))
                  }
                />
              </Stack>
            );
          })}
        </Stack>
      </Box>
    );
  };

  const renderRenameStep = () => (
    <Box>
      <Typography variant="h6" gutterBottom>{t('packages.install.renameTitle')}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('packages.install.renameHelp')}
      </Typography>
      {renameErrors.length > 0 && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Stack spacing={0.5}>
            <Typography variant="body2">{t('packages.install.renameInvalid')}</Typography>
            {renameErrors.slice(0, 8).map((message) => (
              <Typography key={message} variant="caption">{message}</Typography>
            ))}
          </Stack>
        </Alert>
      )}
      {renderRenameGroup('flows', t('packages.install.renameFlows'), flowCandidates)}
      {renderRenameGroup('plannedExecutions', t('packages.install.renameTriggers'), triggerCandidates)}
    </Box>
  );

  const renderSecretsStep = () => (
    <Box>
      <Typography variant="h6" gutterBottom>{t('packages.install.secretsTitle')}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('packages.install.secretsIntro')}
      </Typography>

      {secrets.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{t('packages.install.noSecrets')}</Typography>
      ) : (
        <Stack spacing={2}>
          {secrets.map((secret) => (
            <Box key={secret.key}>
              <TextField
                size="small"
                fullWidth
                label={secret.description || secret.key}
                type={visibleSecrets[secret.key] ? 'text' : 'password'}
                value={secretValues[secret.key] ?? ''}
                onChange={(e) => setSecretValues((current) => ({ ...current, [secret.key]: e.target.value }))}
                helperText={secret.required ? t('packages.install.requiredSecret') : t('packages.install.optional')}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        size="small"
                        aria-label={
                          visibleSecrets[secret.key] ? t('packages.install.hideSecret') : t('packages.install.showSecret')
                        }
                        onClick={() =>
                          setVisibleSecrets((current) => ({ ...current, [secret.key]: !current[secret.key] }))
                        }
                      >
                        {visibleSecrets[secret.key] ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
              {secret.usedBy.length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  {t('packages.install.usedBy', { names: formatList(secret.usedBy.map((u) => u.name)) })}
                </Typography>
              )}
            </Box>
          ))}
        </Stack>
      )}

      {globals.length > 0 && (
        <>
          <Divider sx={{ my: 3 }} />
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            {t('packages.install.globalsTitle')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('packages.install.globalsIntro')}
          </Typography>
          <Stack spacing={2}>
            {globals.map((global) => {
              const visibilityKey = `global:${global.name}`;
              return (
                <Box key={global.name}>
                  <TextField
                    size="small"
                    fullWidth
                    label={global.name}
                    type={global.isSecret && !visibleSecrets[visibilityKey] ? 'password' : 'text'}
                    value={globalValues[global.name] ?? ''}
                    onChange={(e) => setGlobalValues((current) => ({ ...current, [global.name]: e.target.value }))}
                    helperText={
                      global.present
                        ? t('packages.install.keepCurrent', { description: global.description ?? '' })
                        : t('packages.install.notSet', { description: global.description ?? '' })
                    }
                    InputProps={
                      global.isSecret
                        ? {
                            endAdornment: (
                              <InputAdornment position="end">
                                <IconButton
                                  size="small"
                                  aria-label={
                                    visibleSecrets[visibilityKey]
                                      ? t('packages.install.hideGlobal')
                                      : t('packages.install.showGlobal')
                                  }
                                  onClick={() =>
                                    setVisibleSecrets((current) => ({
                                      ...current,
                                      [visibilityKey]: !current[visibilityKey],
                                    }))
                                  }
                                >
                                  {visibleSecrets[visibilityKey] ? (
                                    <VisibilityOff fontSize="small" />
                                  ) : (
                                    <Visibility fontSize="small" />
                                  )}
                                </IconButton>
                              </InputAdornment>
                            ),
                          }
                        : undefined
                    }
                  />
                  <Stack direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: 'wrap' }}>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={global.required ? 'warning' : 'default'}
                      label={global.required ? t('packages.install.required') : t('packages.install.optional')}
                    />
                    {global.present && (
                      <Chip size="small" variant="outlined" color="success" label={t('packages.install.globalSet')} />
                    )}
                    {global.usedBy.length > 0 && (
                      <Typography variant="caption" color="text.secondary">
                        {t('packages.install.usedBy', { names: formatList(global.usedBy.map((u) => u.name)) })}
                      </Typography>
                    )}
                  </Stack>
                </Box>
              );
            })}
          </Stack>
          <Alert severity="info" sx={{ mt: 2 }}>{t('packages.install.setLater')}</Alert>
        </>
      )}
    </Box>
  );

  const renderModelsStep = () => {
    const activeModel = models.find((m) => m.id === activeModelId) ?? models[0];
    if (!activeModel) return null;
    return (
      <Box>
        <Typography variant="h6" gutterBottom>{t('packages.install.modelsMissing')}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('packages.install.replaceModels')}
        </Typography>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
          <Stack spacing={1} sx={{ flex: 1, minWidth: 0, width: '100%' }}>
            <Typography variant="overline" color="text.secondary" fontWeight={700}>
              {t('packages.install.packageModels')}
            </Typography>
            {models.map((model) => {
              const isSelected = model.id === activeModel.id;
              const isResolved = Object.prototype.hasOwnProperty.call(modelMappings, model.id);
              const choice = installedModels.find((installed) => installed.id === modelMappings[model.id]);
              return (
                <Card
                  key={model.id}
                  variant="outlined"
                  sx={{ borderColor: isSelected ? 'primary.main' : 'divider', borderWidth: isSelected ? 2 : 1 }}
                >
                  <CardActionArea
                    onClick={() => {
                      setActiveModelId(model.id);
                      setShowInstalledModels(Boolean(modelMappings[model.id]));
                    }}
                    aria-label={t('packages.install.configureAria', { name: model.displayName })}
                    sx={{ p: 1.5 }}
                  >
                    <Stack direction="row" spacing={1.5} alignItems="center">
                      <SmartToyOutlinedIcon color={isSelected ? 'primary' : 'disabled'} />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle2" fontWeight={700} noWrap>{model.displayName}</Typography>
                        {isResolved && (
                          <Typography variant="caption" color="success.main" noWrap>
                            {choice
                              ? t('packages.install.usingModel', { name: choice.displayName })
                              : t('packages.install.willCreate')}
                          </Typography>
                        )}
                      </Box>
                    </Stack>
                  </CardActionArea>
                </Card>
              );
            })}
          </Stack>

          <Box sx={{ flex: 1.3, minWidth: 0, width: '100%' }}>
            <Typography variant="overline" color="text.secondary" fontWeight={700}>
              {t('packages.install.whatDo')}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ my: 1 }}>
              <Button
                variant={
                  Object.prototype.hasOwnProperty.call(modelMappings, activeModel.id) && !showInstalledModels
                    ? 'contained'
                    : 'outlined'
                }
                onClick={() => {
                  setModelMappings((current) => ({ ...current, [activeModel.id]: '' }));
                  setShowInstalledModels(false);
                }}
              >
                {t('packages.install.createNew')}
              </Button>
              <Button
                variant={showInstalledModels ? 'contained' : 'outlined'}
                onClick={() => setShowInstalledModels(true)}
              >
                {t('packages.install.useYours')}
              </Button>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {showInstalledModels ? t('packages.install.useYoursHelp') : t('packages.install.createNewHelp')}
            </Typography>

            {showInstalledModels && (
              <Stack spacing={1} sx={{ mt: 1.5 }}>
                {installedModels.length === 0 && (
                  <Alert severity="info">{t('packages.install.noInstalledModels')}</Alert>
                )}
                {installedModels.map((installed) => (
                  <Button
                    key={installed.id}
                    variant={modelMappings[activeModel.id] === installed.id ? 'contained' : 'outlined'}
                    aria-label={t('packages.install.useAria', { name: installed.displayName })}
                    onClick={() =>
                      setModelMappings((current) => ({ ...current, [activeModel.id]: installed.id }))
                    }
                  >
                    {installed.displayName}
                  </Button>
                ))}
              </Stack>
            )}
          </Box>
        </Stack>

        {!allModelsResolved && (
          <Alert severity="info" sx={{ mt: 2 }}>{t('packages.install.resolveAll')}</Alert>
        )}
      </Box>
    );
  };

  const renderReviewStep = () => {
    const renamedFlows = Object.keys(renameMaps.flows).length;
    const renamedTriggers = Object.keys(renameMaps.plannedExecutions).length;
    const missingRequiredSecrets = secrets.filter(
      (s) => s.required && !(secretValues[s.key] ?? '').trim(),
    );
    return (
      <Box>
        <Typography variant="h6" gutterBottom>{t('packages.install.reviewTitle')}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('packages.install.reviewHelp')}
        </Typography>

        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2" fontWeight={700} gutterBottom>
            {t('packages.install.planTitle')}
          </Typography>
          <Stack spacing={0.5}>
            <Typography variant="body2">{tp('packages.installed.servers', servers.length)}</Typography>
            <Typography variant="body2">{tp('packages.installed.models', models.length)}</Typography>
            <Typography variant="body2">{tp('packages.installed.flows', flows.length)}</Typography>
            <Typography variant="body2">{tp('packages.installed.planned', triggers.length)}</Typography>
            {(renamedFlows > 0 || renamedTriggers > 0) && (
              <Typography variant="body2" color="text.secondary">
                {t('packages.install.renamedCount', {
                  flows: formatNumber(renamedFlows),
                  triggers: formatNumber(renamedTriggers),
                })}
              </Typography>
            )}
          </Stack>
        </Paper>

        {missingRequiredSecrets.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t('packages.install.missingSecretsWarning', {
              names: formatList(missingRequiredSecrets.map((s) => s.key)),
            })}
          </Alert>
        )}
        {(manifest?.missingGlobals ?? []).length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t('packages.install.missingGlobals', { names: formatList(manifest?.missingGlobals ?? []) })}
          </Alert>
        )}
        {triggers.length > 0 && (
          <Alert severity="info">{t('packages.install.triggersDisabledNote')}</Alert>
        )}
      </Box>
    );
  };

  const renderResult = (summary: InstallSummary) => {
    const installSteps: InstallStep[] = summary.steps ?? [];
    const problems = installSteps.filter((s) => s.status === 'failed' || s.status === 'skipped');
    const partial = summary.ok && (problems.length > 0 || summary.disabled.length > 0);
    return (
      <Box>
        {summary.ok ? (
          <Alert severity={partial ? 'warning' : 'success'} sx={{ mb: 2 }}>
            {partial
              ? t('packages.install.partial', { name: summary.package?.name ?? packageName })
              : t('packages.install.success', {
                  name: summary.package?.name ?? packageName,
                  created: tp('packages.install.created', summary.created.length),
                  updated: tp('packages.install.updated', summary.updated.length),
                  disabled: tp('packages.install.disabled', summary.disabled.length),
                })}
          </Alert>
        ) : (
          <Alert severity="error" sx={{ mb: 2 }}>
            {t('packages.install.failed', {
              error: summary.errors?.[0] ?? t('packages.install.unknownError'),
            })}
          </Alert>
        )}

        {summary.errors.length > 1 && (
          <Box component="ul" sx={{ mt: 0, mb: 2 }}>
            {summary.errors.slice(1).map((message) => (
              <Typography component="li" key={message} variant="caption" sx={{ wordBreak: 'break-word' }}>
                {message}
              </Typography>
            ))}
          </Box>
        )}

        {installSteps.length > 0 && (
          <>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              {t('packages.install.stepsTitle')}
            </Typography>
            <Stack spacing={0.75} sx={{ mb: 2 }}>
              {installSteps.map((step) => (
                <Stack key={`${step.order}-${step.name}`} direction="row" spacing={1} alignItems="flex-start">
                  <Box sx={{ pt: '2px' }}>{STATUS_ICON[step.status]}</Box>
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                      <Typography variant="body2" fontWeight={600}>{step.name}</Typography>
                      <Chip size="small" variant="outlined" label={t(STATUS_LABEL_KEY[step.status])} />
                    </Stack>
                    {step.detail && (
                      <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                        {step.detail}
                      </Typography>
                    )}
                  </Box>
                </Stack>
              ))}
            </Stack>
          </>
        )}

        {summary.missingGlobals.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t('packages.install.missingGlobals', { names: formatList(summary.missingGlobals) })}
          </Alert>
        )}
        {(partial || !summary.ok) && <Alert severity="info">{t('packages.install.retryHint')}</Alert>}
      </Box>
    );
  };

  const renderStep = () => {
    switch (currentStep) {
      case 'models':
        return renderModelsStep();
      case 'apps':
        return renderAppsStep();
      case 'browse':
        return renderBrowseStep();
      case 'rename':
        return renderRenameStep();
      case 'secrets':
        return renderSecretsStep();
      case 'review':
      default:
        return renderReviewStep();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth={false}
      fullWidth
      PaperProps={{
        sx: {
          width: 'min(1200px, calc(100vw - 32px))',
          maxWidth: 'none',
          minHeight: { xs: 'calc(100vh - 32px)', md: 700 },
          maxHeight: 'calc(100vh - 32px)',
          borderRadius: { xs: 2, md: 3 },
        },
      }}
    >
      <DialogHeaderActions
        title={(
          <Box sx={{ minWidth: 0 }}>
            <Typography component="span" variant="h5" fontWeight={700} sx={{ display: 'block' }}>
              {t('packages.install.title', { name: preview?.package?.name ?? packageName })}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {manifest?.info?.description || t('packages.install.subtitle')}
            </Typography>
          </Box>
        )}
        onClose={() => { if (!busy) onClose(); }}
      />

      <DialogContent sx={{ px: { xs: 2, md: 4 }, pb: 3 }}>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

        {loading && !preview && !result && (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 360 }}>
            <CircularProgress size={24} />
          </Box>
        )}

        {result && renderResult(result)}

        {!result && manifest && (
          <Box>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ sm: 'center' }}
              justifyContent="space-between"
              sx={{ mb: 2 }}
            >
              <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Chip size="small" variant="outlined" label={`v${preview?.package?.version ?? version ?? ''}`} />
                {(manifest.info?.publisher || preview?.package?.publisher) && (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={manifest.info?.publisher ?? preview?.package?.publisher ?? ''}
                  />
                )}
                {(manifest.info?.tags ?? []).slice(0, 4).map((tag) => (
                  <Chip key={tag} size="small" label={tag} />
                ))}
                <Typography variant="caption" color="text.secondary">
                  {t('packages.install.summary', {
                    servers: tp('packages.installed.servers', servers.length),
                    models: tp('packages.installed.models', models.length),
                    flows: tp('packages.installed.flows', flows.length),
                    planned: tp('packages.installed.planned', triggers.length),
                  })}
                </Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {t('packages.install.step', {
                  current: formatNumber(Math.min(activeStep, steps.length - 1) + 1),
                  total: formatNumber(steps.length),
                })}
              </Typography>
            </Stack>

            <Stepper activeStep={Math.min(activeStep, steps.length - 1)} sx={{ mb: 3 }} alternativeLabel>
              {steps.map((step) => (
                <Step key={step.key}>
                  <StepLabel>{step.label}</StepLabel>
                </Step>
              ))}
            </Stepper>

            <Box ref={stepPanelRef} tabIndex={-1} sx={{ outline: 'none' }}>
              {renderStep()}
            </Box>
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ px: { xs: 2, md: 4 }, pb: 2 }}>
        <Button onClick={onClose} disabled={installing}>
          {result ? t('packages.install.close') : t('packages.install.cancel')}
        </Button>
        <Box sx={{ flex: 1 }} />
        {!result && (
          <>
            <Button onClick={() => setActiveStep((s) => Math.max(0, s - 1))} disabled={activeStep === 0 || busy}>
              {t('packages.install.back')}
            </Button>
            {currentStep === 'review' ? (
              <Button
                variant="contained"
                onClick={() => void install()}
                disabled={busy || !manifest}
                startIcon={installing ? <CircularProgress size={16} color="inherit" /> : undefined}
              >
                {t('packages.install.action')}
              </Button>
            ) : (
              <Button
                variant="contained"
                onClick={() => setActiveStep((s) => Math.min(steps.length - 1, s + 1))}
                disabled={busy || nextDisabled}
              >
                {currentStep === 'models' && steps[activeStep + 1]?.key === 'review'
                  ? t('packages.install.continueReview')
                  : t('packages.install.next')}
              </Button>
            )}
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
