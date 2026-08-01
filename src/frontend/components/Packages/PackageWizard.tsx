'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Switch,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import RegistryAccountSettings from './RegistryAccountSettings';
import { flowService } from '@/frontend/services/flow';
import { modelService } from '@/frontend/services/model';
import { mcpService } from '@/frontend/services/mcp';
import { plannedExecutionsService } from '@/frontend/services/plannedExecutions';
import { getPackageService } from '@/frontend/services/packages';
import { getRegistryService } from '@/frontend/services/registry';
import type { RegistryPublishResult } from '@/shared/types/registry';
import type {
  BuildManifestResult,
  PackageSelection,
  ResolveResult,
  SecretValueCandidate,
} from '@/frontend/services/packages';
import type { SecretKind, SecretProposal } from '@/shared/types/package/secretProposal';
import type { PackageGlobal } from '@/shared/types/package/package';
import { buildManualProposal, SECRET_KINDS } from '@/shared/types/package/secretProposal';
import { packageToWizardDraft, parseImportedPackage } from '@/shared/types/package/package.import';
import type { WizardDraft } from '@/shared/types/package/package.import';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';
import Trans from '@/frontend/components/shared/Trans';

const log = createLogger('frontend/components/Packages/PackageWizard');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const STEP_KEYS = [
  'packages.wizard.step.select',
  'packages.wizard.step.resolve',
  'packages.wizard.step.secrets',
  'packages.wizard.step.metadata',
  'packages.wizard.step.export',
] as const;

/** Keep the stable manifest identifier while hiding its redundant generated prefix in the wizard. */
export function displaySecretName(name: string): string {
  return name.replace(/^SECRET_/, '');
}

function updateDisplayedSecretName(currentName: string, displayedName: string): string {
  return currentName.startsWith('SECRET_')
    ? `SECRET_${displayedName.replace(/^SECRET_/, '')}`
    : displayedName;
}

interface EntityOption {
  id: string; // flow/model/planned id, or MCP server name
  label: string;
}

interface WizardEntities {
  flows: EntityOption[];
  models: EntityOption[];
  mcpServers: EntityOption[];
  plannedExecutions: EntityOption[];
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Multi-step package-creation wizard (issue #194): select contents → resolve
 * dependencies + validate MCP → review derived secrets → metadata → export.
 * The dependency closure, MCP validation and secret derivation all run on the
 * backend (`/api/packages/resolve`); the final manifest is assembled and
 * downloaded via `/api/packages/build`. No secret values ever leave the host.
 */
export default function PackageWizard({ open, onClose }: Props) {
  const theme = useTheme();
  const { t, tp, formatNumber, formatList } = useI18n();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [activeStep, setActiveStep] = useState(0);

  // Step 0 — available entities + user selection.
  const [entities, setEntities] = useState<WizardEntities>({
    flows: [],
    models: [],
    mcpServers: [],
    plannedExecutions: [],
  });
  const [loadingEntities, setLoadingEntities] = useState(true);
  const [selectedFlows, setSelectedFlows] = useState<Set<string>>(new Set());
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [selectedServers, setSelectedServers] = useState<Set<string>>(new Set());
  const [selectedPlanned, setSelectedPlanned] = useState<Set<string>>(new Set());
  // Step 0 per-column search (issue #285).
  const [flowSearch, setFlowSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [serverSearch, setServerSearch] = useState('');
  const [plannedSearch, setPlannedSearch] = useState('');

  // Step 0 — re-import of a previously exported manifest.
  const [importedDraft, setImportedDraft] = useState<WizardDraft | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);

  // Step 1 — resolution result.
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState<ResolveResult | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [globalDescriptions, setGlobalDescriptions] = useState<Record<string, string>>({});
  const [excludedEntitySecrets, setExcludedEntitySecrets] = useState<Set<string>>(new Set());

  // Step 2 — content-secret derivation (issue #195).
  const [contentProposals, setContentProposals] = useState<SecretProposal[]>([]);
  const [deriving, setDeriving] = useState(false);
  const [derivedOnce, setDerivedOnce] = useState(false);
  const [deriveError, setDeriveError] = useState<string | null>(null);
  const [deriveWarnings, setDeriveWarnings] = useState<string[]>([]);
  const [scanModelId, setScanModelId] = useState<string>('');
  // Step 2 triage controls (issue #208): search + noisy-rule opt-ins.
  const [proposalFilter, setProposalFilter] = useState('');
  const [scanEntropy, setScanEntropy] = useState(false);
  const [scanRepoSlug, setScanRepoSlug] = useState(false);
  // Step 2 manual-add form (issue #208).
  const [manualExcerpt, setManualExcerpt] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualKind, setManualKind] = useState<SecretKind>('other');
  const [manualError, setManualError] = useState<string | null>(null);
  // Step 2 "Pick a value from the app" picker (issue #285).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerCandidates, setPickerCandidates] = useState<SecretValueCandidate[]>([]);
  const [pickerSearch, setPickerSearch] = useState('');
  // Step 4 inline registry login (issue #208).
  const [loginOpen, setLoginOpen] = useState(false);

  // Step 3 — metadata.
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');

  // Step 4 — build result.
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<BuildManifestResult | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);

  // Step 4 — optional publish to the hosted registry (issue #197).
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<RegistryPublishResult | null>(null);

  // Load selectable entities on open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoadingEntities(true);
      try {
        const [flows, models, serverConfigs, planned] = await Promise.all([
          flowService.loadFlows(),
          modelService.loadModels(),
          mcpService.loadServerConfigs(),
          plannedExecutionsService.list(),
        ]);
        if (cancelled) return;
        const serverList = Array.isArray(serverConfigs) ? serverConfigs : [];
        setEntities({
          flows: (flows ?? []).map((f) => ({ id: f.id, label: f.name || f.id })),
          models: (models ?? []).map((m) => ({ id: m.id, label: m.displayName || m.name || m.id })),
          mcpServers: serverList.map((s: { name: string }) => ({ id: s.name, label: s.name })),
          plannedExecutions: (planned?.executions ?? []).map((e) => ({
            id: e.execution.id,
            label: e.execution.name || e.execution.id,
          })),
        });
      } catch (err) {
        log.warn('Failed to load packageable entities', err);
      } finally {
        if (!cancelled) setLoadingEntities(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const selection: PackageSelection = useMemo(
    () => ({
      flowIds: Array.from(selectedFlows),
      modelIds: Array.from(selectedModels),
      mcpServerNames: Array.from(selectedServers),
      plannedExecutionIds: Array.from(selectedPlanned),
    }),
    [selectedFlows, selectedModels, selectedServers, selectedPlanned],
  );

  const nothingSelected =
    selectedFlows.size === 0 &&
    selectedModels.size === 0 &&
    selectedServers.size === 0 &&
    selectedPlanned.size === 0;

  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (id: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * Re-import a previously exported manifest (.json): restores the selection,
   * the metadata fields and which secrets were accepted, so iterating on a
   * package doesn't mean re-walking every step. Secret VALUES are never in a
   * manifest, so accepted rows are matched by NAME after the content scan
   * re-runs (step 2 reports any that can't be recovered).
   */
  const importManifestFile = useCallback(
    async (file: File) => {
      setImportErrors([]);
      let text: string;
      try {
        text = await file.text();
      } catch (err) {
        setImportErrors([err instanceof Error ? err.message : t('packages.wizard.readFailed')]);
        return;
      }
      const parsed = parseImportedPackage(text);
      if (!parsed.ok) {
        setImportedDraft(null);
        setImportErrors(parsed.errors.slice(0, 8));
        return;
      }
      const draft = packageToWizardDraft(parsed.package, {
        flowIds: entities.flows.map((f) => f.id),
        modelIds: entities.models.map((m) => m.id),
        mcpServerNames: entities.mcpServers.map((s) => s.id),
        plannedExecutionIds: entities.plannedExecutions.map((p) => p.id),
      });
      setSelectedFlows(new Set(draft.selection.flowIds));
      setSelectedModels(new Set(draft.selection.modelIds));
      setSelectedServers(new Set(draft.selection.mcpServerNames));
      setSelectedPlanned(new Set(draft.selection.plannedExecutionIds));
      setName(draft.metadata.name);
      setVersion(draft.metadata.version);
      setDescription(draft.metadata.description);
      setTagsInput(draft.metadata.tags.join(', '));
      // Anything derived from the old selection is stale.
      setResolveResult(null);
      setResolveError(null);
      setGlobalDescriptions({});
      setExcludedEntitySecrets(new Set());
      setContentProposals([]);
      setDerivedOnce(false);
      setDeriveError(null);
      setDeriveWarnings([]);
      setBuildResult(null);
      setBuildError(null);
      setPublishResult(null);
      setImportedDraft(draft);
      log.info('Imported package manifest into the wizard', {
        name: draft.metadata.name,
        version: draft.metadata.version,
        missing: draft.missing.length,
      });
    },
    [entities, t],
  );

  const runResolve = useCallback(async () => {
    setResolving(true);
    setResolveError(null);
    setResolveResult(null);
    setGlobalDescriptions({});
    setExcludedEntitySecrets(new Set());
    // The selection changed — any previously derived proposals are now stale.
    setContentProposals([]);
    setDerivedOnce(false);
    setDeriveError(null);
    setDeriveWarnings([]);
    try {
      const result = await getPackageService().resolve(selection);
      setResolveResult(result);
      setGlobalDescriptions(
        Object.fromEntries((result.globals ?? []).map((entry) => [entry.name, entry.description ?? ''])),
      );
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : t('packages.wizard.resolveFailed'));
    } finally {
      setResolving(false);
    }
  }, [selection, t]);

  /**
   * Run the content-secret derivation (issue #195). Heuristic-only unless a
   * model is passed, in which case the optional model-driven pass also runs
   * (sending packaged content to that provider). Preserves the user's per-row
   * accept/rename choices across a re-scan.
   */
  const importedSecretNames = useMemo(
    () => (importedDraft ? new Set(importedDraft.secretNames) : null),
    [importedDraft],
  );

  const runDerive = useCallback(
    async (modelIdentifier?: string) => {
      setDeriving(true);
      setDeriveError(null);
      try {
        const res = await getPackageService().deriveSecrets(selection, {
          modelIdentifier,
          enableEntropy: scanEntropy,
          enableRepoSlug: scanRepoSlug,
        });
        setContentProposals((prev) => {
          // Keep the user's per-row accept/rename choices across a re-scan, and
          // preserve any manually-added rows (they never come back from the API).
          const acceptedById = new Map(prev.map((p) => [p.id, p.accepted]));
          const nameById = new Map(prev.map((p) => [p.id, p.suggestedSecretName]));
          const manual = prev.filter((p) => p.source === 'manual');
          // After a manifest re-import, reproduce the imported package's choices:
          // accept exactly the rows whose suggested name it declared.
          const imported = importedSecretNames;
          const scanned = res.proposals.map((p) => ({
            ...p,
            accepted: acceptedById.has(p.id)
              ? acceptedById.get(p.id)
              : imported
                ? imported.has(p.suggestedSecretName)
                : // Default-accept everything except low-confidence noise (issue #208).
                  p.confidence !== 'low',
            suggestedSecretName: nameById.get(p.id) ?? p.suggestedSecretName,
          }));
          const scannedIds = new Set(scanned.map((p) => p.id));
          return [...scanned, ...manual.filter((p) => !scannedIds.has(p.id))];
        });
        setDeriveWarnings(res.warnings ?? []);
      } catch (err) {
        setDeriveError(err instanceof Error ? err.message : t('packages.wizard.deriveFailed'));
      } finally {
        setDeriving(false);
        setDerivedOnce(true);
      }
    },
    [selection, scanEntropy, scanRepoSlug, importedSecretNames, t],
  );

  const toggleProposalGroup = (ids: string[]) =>
    setContentProposals((prev) => {
      const idSet = new Set(ids);
      const nextAccepted = !prev.find((p) => idSet.has(p.id))?.accepted;
      return prev.map((p) => (idSet.has(p.id) ? { ...p, accepted: nextAccepted } : p));
    });
  const setAllProposals = (accepted: boolean) =>
    setContentProposals((prev) => prev.map((p) => ({ ...p, accepted })));
  const renameProposalGroup = (ids: string[], name: string) =>
    setContentProposals((prev) => {
      const idSet = new Set(ids);
      return prev.map((p) => (idSet.has(p.id) ? { ...p, suggestedSecretName: name } : p));
    });

  /** Add a user-entered secret to the review list (issue #208). */
  const addManualProposal = () => {
    setManualError(null);
    const proposal = buildManualProposal({
      excerpt: manualExcerpt,
      secretName: manualName,
      kind: manualKind,
    });
    if (!proposal) {
      setManualError(t('packages.wizard.manualInvalid'));
      return;
    }
    setContentProposals((prev) =>
      prev.some((p) => p.id === proposal.id) ? prev : [proposal, ...prev],
    );
    setManualExcerpt('');
    setManualName('');
    setManualKind('other');
  };

  /** Open the value picker and load candidate strings from the packaged content (#285). */
  const openValuePicker = useCallback(async () => {
    setPickerOpen(true);
    setPickerError(null);
    setPickerSearch('');
    setPickerLoading(true);
    try {
      const candidates = await getPackageService().scanTargets(selection);
      setPickerCandidates(candidates);
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : t('packages.wizard.candidatesFailed'));
      setPickerCandidates([]);
    } finally {
      setPickerLoading(false);
    }
  }, [selection, t]);

  /** Pick a candidate value: pre-fill the manual-secret form and close the picker (#285). */
  const pickValue = (candidate: SecretValueCandidate) => {
    setManualExcerpt(candidate.text);
    setManualError(null);
    setPickerOpen(false);
  };

  const filteredCandidates = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    if (!q) return pickerCandidates;
    return pickerCandidates.filter((c) =>
      `${c.text} ${c.location} ${c.source}`.toLowerCase().includes(q),
    );
  }, [pickerCandidates, pickerSearch]);

  // Collapse proposals that share the same kind + excerpt (i.e. the same secret
  // value detected at multiple locations) into a single review row — accepting
  // one already redacts every occurrence via `SecretSubstitution.excerpt`, so
  // showing a row per occurrence just bloats the list (#285 follow-up).
  const groupedProposals = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        ids: string[];
        locations: string[];
        kind: SecretKind;
        source: SecretProposal['source'];
        confidence: SecretProposal['confidence'];
        excerpt: string;
        suggestedSecretName: string;
        rationale?: string;
        accepted?: boolean;
      }
    >();
    for (const p of contentProposals) {
      const key = `${p.kind}::${p.excerpt}`;
      const existing = groups.get(key);
      if (existing) {
        existing.ids.push(p.id);
        existing.locations.push(p.location);
      } else {
        groups.set(key, {
          key,
          ids: [p.id],
          locations: [p.location],
          kind: p.kind,
          source: p.source,
          confidence: p.confidence,
          excerpt: p.excerpt,
          suggestedSecretName: p.suggestedSecretName,
          rationale: p.rationale,
          accepted: p.accepted,
        });
      }
    }
    return Array.from(groups.values());
  }, [contentProposals]);

  const filteredProposals = useMemo(() => {
    const q = proposalFilter.trim().toLowerCase();
    if (!q) return groupedProposals;
    return groupedProposals.filter((g) =>
      `${g.excerpt} ${g.locations.join(' ')} ${g.kind} ${g.suggestedSecretName}`
        .toLowerCase()
        .includes(q),
    );
  }, [groupedProposals, proposalFilter]);

  // Secrets the imported manifest declared that neither the entity-secret step
  // nor the re-run content scan produced — their VALUES were redacted on export,
  // so they can only be restored by re-adding them manually (issue: re-import).
  const unrecoveredSecretNames = useMemo(() => {
    if (!importedDraft || !derivedOnce) return [];
    const known = new Set<string>([
      ...(resolveResult?.secrets ?? []).map((s) => s.name),
      ...contentProposals.map((p) => p.suggestedSecretName),
    ]);
    return importedDraft.secretNames.filter((n) => !known.has(n));
  }, [importedDraft, derivedOnce, resolveResult, contentProposals]);

  const kindCounts = useMemo(() => {
    const counts = new Map<SecretKind, number>();
    for (const g of groupedProposals) counts.set(g.kind, (counts.get(g.kind) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [groupedProposals]);

  // Auto-run the offline heuristic derivation when the user reaches the step.
  useEffect(() => {
    if (activeStep === 2 && resolveResult && !derivedOnce && !deriving) {
      void runDerive();
    }
  }, [activeStep, resolveResult, derivedOnce, deriving, runDerive]);

  const runBuild = useCallback(async () => {
    setBuilding(true);
    setBuildError(null);
    setBuildResult(null);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const result = await getPackageService().build(
        selection,
        {
          id: `pkg-${Date.now()}`,
          name: name.trim(),
          version: version.trim(),
          description: description.trim() || undefined,
          tags: tags.length ? tags : undefined,
        },
        contentProposals.filter((p) => p.accepted),
        (resolveResult?.globals ?? []).map<PackageGlobal>((entry) => ({
          ...entry,
          description: globalDescriptions[entry.name]?.trim() || entry.description,
        })),
        Array.from(excludedEntitySecrets),
      );
      setBuildResult(result);
      if (!result.ok) {
        setBuildError((result.errors && result.errors[0]) || t('packages.wizard.buildFailed'));
      }
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : t('packages.wizard.buildRequestFailed'));
    } finally {
      setBuilding(false);
    }
  }, [
    selection,
    name,
    version,
    description,
    tagsInput,
    contentProposals,
    resolveResult,
    globalDescriptions,
    excludedEntitySecrets,
    t,
  ]);

  /**
   * Publish the built manifest to the hosted package registry (issue #197).
   * Requires a confirmed, signed-in registry account (managed on the Packages
   * page); friendly errors are surfaced from the service.
   */
  const publishToRegistry = useCallback(async () => {
    if (!buildResult?.json) return;
    setPublishing(true);
    setPublishResult(null);
    try {
      const manifest = JSON.parse(buildResult.json);
      const result = await getRegistryService().publish(manifest);
      setPublishResult(result);
    } catch (err) {
      setPublishResult({
        ok: false,
        code: 'error',
        error: err instanceof Error ? err.message : t('packages.wizard.publishFailed'),
      });
    } finally {
      setPublishing(false);
    }
  }, [buildResult, t]);

  const downloadManifest = () => {
    if (!buildResult?.json) return;
    const blob = new Blob([buildResult.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safe = name.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'package';
    a.download = `${safe}-${version.trim()}.flujo-package.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleNext = async () => {
    if (activeStep === 0) {
      await runResolve();
      setActiveStep(1);
      return;
    }
    if (activeStep === 3) {
      setActiveStep(4);
      await runBuild();
      return;
    }
    setActiveStep((s) => Math.min(s + 1, STEP_KEYS.length - 1));
  };

  const handleBack = () => setActiveStep((s) => Math.max(s - 1, 0));

  const versionValid = SEMVER.test(version.trim());
  const metadataValid = name.trim().length > 0 && versionValid;
  const mcpBlocked = Boolean(resolveResult && !resolveResult.mcp.ok);

  const entityTypeLabel = (type: string) => {
    switch (type) {
      case 'flow': return t('packages.wizard.entity.flow');
      case 'model': return t('packages.wizard.entity.model');
      case 'mcpServer': return t('packages.wizard.entity.mcpServer');
      case 'plannedExecution': return t('packages.wizard.entity.plannedExecution');
      default: return type;
    }
  };

  const autoReasonLabel = (reason: string) => {
    const planned = /^used by planned execution "(.+)"$/.exec(reason);
    if (planned) return t('packages.wizard.reason.planned', { name: planned[1] });
    const subflow = /^subflow of "(.+)"$/.exec(reason);
    if (subflow) return t('packages.wizard.reason.subflow', { name: subflow[1] });
    const flow = /^used by flow "(.+)"$/.exec(reason);
    if (flow) return t('packages.wizard.reason.flow', { name: flow[1] });
    return reason;
  };

  const nextDisabled = (() => {
    if (activeStep === 0) return nothingSelected || resolving;
    if (activeStep === 1) return resolving || Boolean(resolveError) || mcpBlocked;
    if (activeStep === 3) return !metadataValid;
    if (activeStep === 4) return true;
    return false;
  })();

  const renderList = (
    title: string,
    options: EntityOption[],
    selected: Set<string>,
    onToggle: (id: string) => void,
    search: string,
    onSearch: (value: string) => void,
  ) => {
    const q = search.trim().toLowerCase();
    const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    return (
      <Box sx={{ flex: 1, minWidth: 240 }}>
        <Typography variant="subtitle2" gutterBottom>
          {title} {selected.size > 0 && <Chip label={selected.size} size="small" />}
        </Typography>
        <TextField
          size="small"
          fullWidth
          placeholder={t('packages.wizard.search', { category: title.toLocaleLowerCase() })}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          sx={{ mb: 1 }}
        />
        {options.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t('packages.wizard.noneAvailable')}
          </Typography>
        ) : filtered.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t('packages.wizard.noMatches', { search })}
          </Typography>
        ) : (
          <List dense sx={{ maxHeight: { xs: 240, md: '45vh' }, overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
            {filtered.map((opt) => (
              <ListItem key={opt.id} disablePadding>
                <ListItemButton onClick={() => onToggle(opt.id)} dense>
                  <ListItemIcon sx={{ minWidth: 36 }}>
                    <Checkbox edge="start" checked={selected.has(opt.id)} tabIndex={-1} disableRipple />
                  </ListItemIcon>
                  <ListItemText primary={opt.label} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
      </Box>
    );
  };

  const renderStepContent = () => {
    switch (activeStep) {
      case 0:
        return loadingEntities ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              {t('packages.wizard.selectHelp')}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
                {t('packages.wizard.import')}
                <input
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Reset the input so re-picking the same file fires onChange again.
                    e.target.value = '';
                    if (file) void importManifestFile(file);
                  }}
                />
              </Button>
              <Typography variant="caption" color="text.secondary">
                {t('packages.wizard.importHelp')}
              </Typography>
            </Stack>
            {importErrors.length > 0 && (
              <Alert severity="error" onClose={() => setImportErrors([])}>
                <AlertTitle>{t('packages.wizard.importErrorTitle')}</AlertTitle>
                {importErrors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </Alert>
            )}
            {importedDraft && (
              <Alert severity={importedDraft.missing.length > 0 ? 'warning' : 'success'}>
                <AlertTitle>
                  {t('packages.wizard.importedTitle', {
                    name: importedDraft.metadata.name,
                    version: importedDraft.metadata.version,
                  })}
                </AlertTitle>
                {t('packages.wizard.importedSummary', {
                  flows: tp('packages.installed.flows', importedDraft.selection.flowIds.length),
                  models: tp('packages.installed.models', importedDraft.selection.modelIds.length),
                  servers: tp('packages.installed.servers', importedDraft.selection.mcpServerNames.length),
                  planned: tp('packages.installed.planned', importedDraft.selection.plannedExecutionIds.length),
                  secrets: tp('packages.wizard.secretNames', importedDraft.secretNames.length),
                })}
                {importedDraft.missing.length > 0 && (
                  <Box sx={{ mt: 1 }}>
                    {t('packages.wizard.missingHost')}
                    {importedDraft.missing.map((m, i) => (
                      <div key={i}>
                        {entityTypeLabel(m.type)}: {m.label}
                      </div>
                    ))}
                  </Box>
                )}
              </Alert>
            )}
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              {renderList(t('packages.wizard.flows'), entities.flows, selectedFlows, toggle(setSelectedFlows), flowSearch, setFlowSearch)}
              {renderList(t('packages.wizard.models'), entities.models, selectedModels, toggle(setSelectedModels), modelSearch, setModelSearch)}
              {renderList(t('packages.wizard.servers'), entities.mcpServers, selectedServers, toggle(setSelectedServers), serverSearch, setServerSearch)}
              {renderList(t('packages.wizard.planned'), entities.plannedExecutions, selectedPlanned, toggle(setSelectedPlanned), plannedSearch, setPlannedSearch)}
            </Stack>
          </Stack>
        );
      case 1:
        if (resolving) {
          return (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress />
            </Box>
          );
        }
        if (resolveError) {
          return <Alert severity="error">{resolveError}</Alert>;
        }
        if (!resolveResult) return null;
        return (
          <Stack spacing={2}>
            {mcpBlocked && (
              <Alert severity="error">
                <AlertTitle>{t('packages.wizard.localMcpTitle')}</AlertTitle>
                {resolveResult.mcp.errors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </Alert>
            )}
            {resolveResult.resolved.autoAdded.length > 0 && (
              <Alert severity="info">
                <AlertTitle>{t('packages.wizard.autoDependencies')}</AlertTitle>
                {resolveResult.resolved.autoAdded.map((a, i) => (
                  <div key={i}>
                    {entityTypeLabel(a.type)}: <code>{a.id}</code> — {autoReasonLabel(a.reason)}
                  </div>
                ))}
              </Alert>
            )}
            {resolveResult.resolved.warnings.length > 0 && (
              <Alert severity="warning">
                <AlertTitle>{t('packages.wizard.warnings')}</AlertTitle>
                {resolveResult.resolved.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </Alert>
            )}
            <Divider />
            <Typography variant="body2">
              {t('packages.wizard.resolved', {
                flows: tp('packages.installed.flows', resolveResult.resolved.flowIds.length),
                models: tp('packages.installed.models', resolveResult.resolved.modelIds.length),
                servers: tp('packages.installed.servers', resolveResult.resolved.mcpServerNames.length),
                planned: tp('packages.installed.planned', resolveResult.resolved.plannedExecutionIds.length),
              })}
            </Typography>
            {resolveResult.mcp.servers.length > 0 && (
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {resolveResult.mcp.servers.map((s) => (
                  <Chip key={s.name} label={`${s.name} · ${s.sourceType}`} size="small" color="success" variant="outlined" />
                ))}
              </Stack>
            )}
          </Stack>
        );
      case 2:
        return (
          <Stack spacing={2}>
            <Typography variant="subtitle2">{t('packages.wizard.globals')}</Typography>
            <Typography variant="body2" color="text.secondary">
              {t('packages.wizard.globalsHelp')}
            </Typography>
            {!resolveResult || (resolveResult.globals ?? []).length === 0 ? (
              <Alert severity="success">{t('packages.wizard.noGlobals')}</Alert>
            ) : (
              <Stack spacing={1.5}>
                {resolveResult.globals.map((entry) => (
                  <Stack key={entry.name} direction="row" spacing={1} alignItems="flex-start">
                    <TextField
                      size="small"
                      label={entry.name}
                      value={globalDescriptions[entry.name] ?? ''}
                      onChange={(event) =>
                        setGlobalDescriptions((current) => ({
                          ...current,
                          [entry.name]: event.target.value,
                        }))
                      }
                      helperText={
                        entry.isSecret
                          ? t('packages.wizard.secretGlobalHelp')
                          : t('packages.wizard.descriptionHelp')
                      }
                      fullWidth
                    />
                    {entry.isSecret && (
                      <Chip label={t('packages.wizard.secretGlobal')} size="small" color="warning" variant="outlined" />
                    )}
                  </Stack>
                ))}
              </Stack>
            )}

            <Divider />

            <Typography variant="subtitle2">{t('packages.wizard.entitySecrets')}</Typography>
            <Typography variant="body2" color="text.secondary">
              {t('packages.wizard.entitySecretsHelp')}
            </Typography>
            {!resolveResult || resolveResult.secrets.length === 0 ? (
              <Alert severity="success">{t('packages.wizard.noEntitySecrets')}</Alert>
            ) : (
              <List dense>
                {resolveResult.secrets.map((s) => (
                  <ListItem key={s.name}>
                    <Checkbox
                      edge="start"
                      checked={!excludedEntitySecrets.has(s.name)}
                      onChange={(event) =>
                        setExcludedEntitySecrets((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.delete(s.name);
                          else next.add(s.name);
                          return next;
                        })
                      }
                      inputProps={{ 'aria-label': t('packages.wizard.includeSecretAria', { name: s.name }) }}
                    />
                    <ListItemText
                      primary={
                        <>
                          <code>{displaySecretName(s.name)}</code>{' '}
                          {s.required && <Chip label={t('packages.wizard.required')} size="small" color="warning" />}
                        </>
                      }
                      secondary={
                        excludedEntitySecrets.has(s.name)
                          ? t('packages.wizard.excluded')
                          : s.description
                      }
                    />
                  </ListItem>
                ))}
              </List>
            )}

            <Divider />

            <Typography variant="subtitle2">{t('packages.wizard.detectedSecrets')}</Typography>
            <Typography variant="body2" color="text.secondary">
              <Trans
                message="packages.wizard.detectedHelp"
                values={{ placeholder: <code>{'{{secret.NAME}}'}</code> }}
              />
            </Typography>

            {deriving && (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                <CircularProgress size={28} />
              </Box>
            )}
            {deriveError && <Alert severity="error">{deriveError}</Alert>}

            {!deriving && derivedOnce && contentProposals.length === 0 && (
              <Alert severity="success">{t('packages.wizard.noDetected')}</Alert>
            )}

            {contentProposals.length > 0 && (
              <>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {kindCounts.map(([kind, count]) => (
                    <Chip
                      key={kind}
                      size="small"
                      variant="outlined"
                      label={`${t(`packages.wizard.kind.${kind}`)}: ${formatNumber(count)}`}
                    />
                  ))}
                </Stack>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Button size="small" onClick={() => setAllProposals(true)}>
                    {t('packages.wizard.acceptAll')}
                  </Button>
                  <Button size="small" onClick={() => setAllProposals(false)}>
                    {t('packages.wizard.rejectAll')}
                  </Button>
                  <TextField
                    size="small"
                    placeholder={t('packages.wizard.filterSecrets')}
                    value={proposalFilter}
                    onChange={(e) => setProposalFilter(e.target.value)}
                    sx={{ minWidth: 200, flex: 1 }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                    {t('packages.wizard.accepted', {
                      accepted: formatNumber(groupedProposals.filter((g) => g.accepted).length),
                      total: formatNumber(groupedProposals.length),
                    })}
                  </Typography>
                </Stack>
                <List dense sx={{ border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: 280, overflow: 'auto' }}>
                  {filteredProposals.length === 0 && (
                    <ListItem>
                      <ListItemText
                        primary={
                          <Typography variant="body2" color="text.secondary">
                            {t('packages.wizard.noRows', { search: proposalFilter })}
                          </Typography>
                        }
                      />
                    </ListItem>
                  )}
                  {filteredProposals.map((g) => (
                    <ListItem key={g.key} alignItems="flex-start" divider>
                      <ListItemIcon sx={{ minWidth: 36, mt: 1 }}>
                        <Checkbox
                          edge="start"
                          checked={Boolean(g.accepted)}
                          onChange={() => toggleProposalGroup(g.ids)}
                          tabIndex={-1}
                          disableRipple
                        />
                      </ListItemIcon>
                      <ListItemText
                        primary={
                          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                            <Chip label={t(`packages.wizard.kind.${g.kind}`)} size="small" />
                            <Chip
                              label={t(`packages.wizard.source.${g.source}`)}
                              size="small"
                              variant="outlined"
                              color={g.source === 'model' ? 'secondary' : g.source === 'manual' ? 'primary' : 'default'}
                            />
                            {g.confidence && (
                              <Chip
                                label={t(`packages.wizard.confidence.${g.confidence}`)}
                                size="small"
                                variant="outlined"
                                color={
                                  g.confidence === 'high'
                                    ? 'success'
                                    : g.confidence === 'low'
                                      ? 'warning'
                                      : 'default'
                                }
                              />
                            )}
                            {g.locations.length > 1 && (
                              <Chip label={`${g.locations.length}×`} size="small" variant="outlined" />
                            )}
                            <Box component="code" sx={{ wordBreak: 'break-all' }}>
                              {g.excerpt.length > 80 ? `${g.excerpt.slice(0, 80)}…` : g.excerpt}
                            </Box>
                          </Stack>
                        }
                        secondary={
                          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                            <Typography variant="caption" color="text.secondary">
                              {g.locations.length > 1
                                ? tp('packages.wizard.locations', g.locations.length, {
                                    locations: `${g.locations.slice(0, 3).join(', ')}${g.locations.length > 3 ? ', …' : ''}`,
                                  })
                                : g.locations[0]}
                              {g.rationale ? ` — ${g.rationale}` : ''}
                            </Typography>
                            <TextField
                              size="small"
                              label={t('packages.wizard.secretName')}
                              value={displaySecretName(g.suggestedSecretName)}
                              onChange={(e) => renameProposalGroup(
                                g.ids,
                                updateDisplayedSecretName(g.suggestedSecretName, e.target.value),
                              )}
                              disabled={!g.accepted}
                              sx={{ maxWidth: 320 }}
                            />
                          </Stack>
                        }
                        primaryTypographyProps={{ component: 'div' }}
                        secondaryTypographyProps={{ component: 'div' }}
                      />
                    </ListItem>
                  ))}
                </List>
              </>
            )}

            {unrecoveredSecretNames.length > 0 && (
              <Alert severity="warning">
                <AlertTitle>{t('packages.wizard.unrecoveredTitle')}</AlertTitle>
                {t('packages.wizard.unrecoveredHelp', {
                  names: formatList(unrecoveredSecretNames.map(displaySecretName)),
                })}
              </Alert>
            )}

            {deriveWarnings.length > 0 && (
              <Alert severity="warning">
                <AlertTitle>{t('packages.wizard.notes')}</AlertTitle>
                {deriveWarnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </Alert>
            )}

            <Divider />
            <Typography variant="subtitle2">{t('packages.wizard.manualTitle')}</Typography>
            <Typography variant="body2" color="text.secondary">
              <Trans
                message="packages.wizard.manualHelp"
                values={{ placeholder: <code>{'{{secret.NAME}}'}</code> }}
              />
            </Typography>
            {manualError && <Alert severity="error">{manualError}</Alert>}
            <Stack direction="row" spacing={1} alignItems="flex-start" flexWrap="wrap" useFlexGap>
              <TextField
                size="small"
                label={t('packages.wizard.valueRedact')}
                value={manualExcerpt}
                onChange={(e) => setManualExcerpt(e.target.value)}
                sx={{ minWidth: 240, flex: 1 }}
              />
              <TextField
                size="small"
                label={t('packages.wizard.secretName')}
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                sx={{ minWidth: 180 }}
              />
              <Select
                size="small"
                value={manualKind}
                onChange={(e) => setManualKind(e.target.value as SecretKind)}
                sx={{ minWidth: 120 }}
              >
                {SECRET_KINDS.map((k) => (
                  <MenuItem key={k} value={k}>
                    {t(`packages.wizard.kind.${k}`)}
                  </MenuItem>
                ))}
              </Select>
              <Button variant="outlined" onClick={addManualProposal} disabled={!manualExcerpt.trim()}>
                {t('packages.wizard.add')}
              </Button>
              <Button
                variant="text"
                startIcon={<SearchIcon />}
                onClick={() => void openValuePicker()}
                disabled={nothingSelected}
              >
                {t('packages.wizard.pickApp')}
              </Button>
            </Stack>

            <Divider />
            <Typography variant="subtitle2">{t('packages.wizard.advancedScan')}</Typography>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              <FormControlLabel
                control={
                  <Switch
                    checked={scanEntropy}
                    onChange={(e) => {
                      setScanEntropy(e.target.checked);
                      setDerivedOnce(false);
                    }}
                  />
                }
                label={t('packages.wizard.entropy')}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={scanRepoSlug}
                    onChange={(e) => {
                      setScanRepoSlug(e.target.checked);
                      setDerivedOnce(false);
                    }}
                  />
                }
                label={t('packages.wizard.repoSlug')}
              />
              <Button size="small" variant="text" onClick={() => void runDerive()} disabled={deriving}>
                {t('packages.wizard.rescan')}
              </Button>
            </Stack>

            <Divider />
            <Typography variant="subtitle2">{t('packages.wizard.modelScan')}</Typography>
            <Alert severity="info">
              {t('packages.wizard.modelScanHelp')}
            </Alert>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Select
                size="small"
                displayEmpty
                value={scanModelId}
                onChange={(e) => setScanModelId(e.target.value as string)}
                sx={{ minWidth: 220 }}
              >
                <MenuItem value="">
                  <em>{t('packages.wizard.selectModel')}</em>
                </MenuItem>
                {entities.models.map((m) => (
                  <MenuItem key={m.id} value={m.id}>
                    {m.label}
                  </MenuItem>
                ))}
              </Select>
              <Button
                variant="outlined"
                disabled={!scanModelId || deriving}
                onClick={() => void runDerive(scanModelId)}
              >
                {t('packages.wizard.scanModel')}
              </Button>
            </Stack>
          </Stack>
        );
      case 3:
        return (
          <Stack spacing={2}>
            <TextField
              label={t('packages.wizard.packageName')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              fullWidth
              error={name.length > 0 && name.trim().length === 0}
            />
            <TextField
              label={t('packages.wizard.version')}
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              required
              fullWidth
              error={version.length > 0 && !versionValid}
              helperText={version.length > 0 && !versionValid ? t('packages.wizard.semverHelp') : ' '}
            />
            <TextField
              label={t('packages.wizard.description')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              fullWidth
              multiline
              minRows={2}
            />
            <TextField
              label={t('packages.wizard.tags')}
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              fullWidth
            />
          </Stack>
        );
      case 4:
        if (building) {
          return (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress />
            </Box>
          );
        }
        if (buildError) {
          return <Alert severity="error">{buildError}</Alert>;
        }
        if (buildResult?.ok) {
          return (
            <Stack spacing={2}>
              <Alert severity="success">
                <AlertTitle>{t('packages.wizard.builtTitle')}</AlertTitle>
                {t('packages.wizard.builtHelp', { name: name.trim(), version: version.trim() })}
              </Alert>
              {buildResult.warnings.length > 0 && (
                <Alert severity="warning">
                  <AlertTitle>{t('packages.wizard.warnings')}</AlertTitle>
                  {buildResult.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </Alert>
              )}
              <Button variant="contained" onClick={downloadManifest}>
                {t('packages.wizard.download')}
              </Button>

              <Divider />
              <Typography variant="subtitle2">{t('packages.wizard.publishTitle')}</Typography>
              <Typography variant="body2" color="text.secondary">
                {t('packages.wizard.publishHelp')}
              </Typography>
              {publishResult?.ok ? (
                <Alert severity="success">
                  <AlertTitle>{t('packages.wizard.published')}</AlertTitle>
                  {t('packages.wizard.live', {
                    name: publishResult.name || name.trim(),
                    version: publishResult.version || version.trim(),
                  })}
                  {publishResult.url && (
                    <div>
                      <a href={publishResult.url} target="_blank" rel="noreferrer">
                        {publishResult.url}
                      </a>
                    </div>
                  )}
                </Alert>
              ) : (
                <>
                  {publishResult && !publishResult.ok && (
                    <Alert severity={publishResult.code === 'unconfirmed' || publishResult.code === 'not_authenticated' ? 'warning' : 'error'}>
                      {publishResult.error || t('packages.wizard.publishFailed')}
                    </Alert>
                  )}
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Button variant="outlined" onClick={() => void publishToRegistry()} disabled={publishing}>
                      {publishing ? t('packages.wizard.publishing') : t('packages.wizard.publish')}
                    </Button>
                    {publishResult &&
                      !publishResult.ok &&
                      (publishResult.code === 'not_authenticated' || publishResult.code === 'unconfirmed') && (
                        <Button variant="contained" onClick={() => setLoginOpen(true)} disabled={publishing}>
                          {t('packages.wizard.loginRegistry')}
                        </Button>
                      )}
                  </Stack>
                </>
              )}
            </Stack>
          );
        }
        return null;
      default:
        return null;
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth="lg"
        fullWidth
        fullScreen={fullScreen}
        PaperProps={{ sx: { height: fullScreen ? '100%' : '90vh', maxHeight: fullScreen ? '100%' : '90vh' } }}
      >
        <DialogTitle>{t('packages.wizard.title')}</DialogTitle>
        <DialogContent dividers sx={{ overflow: 'auto' }}>
          <Stepper activeStep={activeStep} sx={{ mb: 3 }}>
            {STEP_KEYS.map((key) => (
              <Step key={key}>
                <StepLabel>{t(key)}</StepLabel>
              </Step>
            ))}
          </Stepper>
          {renderStepContent()}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{buildResult?.ok ? t('packages.wizard.close') : t('packages.wizard.cancel')}</Button>
          <Box sx={{ flex: 1 }} />
          <Button onClick={handleBack} disabled={activeStep === 0 || building || resolving}>
            {t('packages.wizard.back')}
          </Button>
          {activeStep < 4 && (
            <Button variant="contained" onClick={handleNext} disabled={nextDisabled}>
              {activeStep === 3 ? t('packages.wizard.build') : t('packages.wizard.next')}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={loginOpen} onClose={() => setLoginOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('packages.wizard.loginTitle')}</DialogTitle>
        <DialogContent dividers>
          <RegistryAccountSettings />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLoginOpen(false)}>{t('packages.wizard.done')}</Button>
          <Button
            variant="contained"
            onClick={() => {
              setLoginOpen(false);
              void publishToRegistry();
            }}
            disabled={publishing}
          >
            {t('packages.wizard.retryPublish')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={pickerOpen} onClose={() => setPickerOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{t('packages.wizard.pickerTitle')}</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('packages.wizard.pickerHelp')}
          </Typography>
          <TextField
            size="small"
            fullWidth
            placeholder={t('packages.wizard.searchValues')}
            value={pickerSearch}
            onChange={(e) => setPickerSearch(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
            sx={{ mb: 2 }}
          />
          {pickerLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress />
            </Box>
          ) : pickerError ? (
            <Alert severity="error">{pickerError}</Alert>
          ) : pickerCandidates.length === 0 ? (
            <Alert severity="info">{t('packages.wizard.noCandidates')}</Alert>
          ) : filteredCandidates.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {t('packages.wizard.noValueMatches', { search: pickerSearch })}
            </Typography>
          ) : (
            <List dense sx={{ border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: '50vh', overflow: 'auto' }}>
              {filteredCandidates.map((c, i) => (
                <ListItem key={`${c.location}-${i}`} disablePadding divider>
                  <ListItemButton onClick={() => pickValue(c)} alignItems="flex-start">
                    <ListItemText
                      primary={
                        <Box component="code" sx={{ wordBreak: 'break-all' }}>
                          {c.text.length > 120 ? `${c.text.slice(0, 120)}…` : c.text}
                        </Box>
                      }
                      secondary={
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                          <Chip label={entityTypeLabel(c.source)} size="small" variant="outlined" />
                          <Typography variant="caption" color="text.secondary">
                            {c.location}
                          </Typography>
                        </Stack>
                      }
                      primaryTypographyProps={{ component: 'div' }}
                      secondaryTypographyProps={{ component: 'div' }}
                    />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPickerOpen(false)}>{t('packages.wizard.close')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
