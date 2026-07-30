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

const log = createLogger('frontend/components/Packages/PackageWizard');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const STEPS = ['Select contents', 'Resolve & validate', 'Secret review', 'Metadata', 'Export'];

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
        setImportErrors([err instanceof Error ? err.message : 'Failed to read the file']);
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
    [entities],
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
      setResolveError(err instanceof Error ? err.message : 'Failed to resolve dependencies');
    } finally {
      setResolving(false);
    }
  }, [selection]);

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
        setDeriveError(err instanceof Error ? err.message : 'Failed to derive secrets');
      } finally {
        setDeriving(false);
        setDerivedOnce(true);
      }
    },
    [selection, scanEntropy, scanRepoSlug, importedSecretNames],
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
      setManualError('Enter a non-empty value to redact (under 2000 characters).');
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
      setPickerError(err instanceof Error ? err.message : 'Failed to load candidate values');
      setPickerCandidates([]);
    } finally {
      setPickerLoading(false);
    }
  }, [selection]);

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
    const counts = new Map<string, number>();
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
        setBuildError((result.errors && result.errors[0]) || 'Package build failed');
      }
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Failed to build package');
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
        error: err instanceof Error ? err.message : 'Failed to publish package',
      });
    } finally {
      setPublishing(false);
    }
  }, [buildResult]);

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
    setActiveStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const handleBack = () => setActiveStep((s) => Math.max(s - 1, 0));

  const versionValid = SEMVER.test(version.trim());
  const metadataValid = name.trim().length > 0 && versionValid;
  const mcpBlocked = Boolean(resolveResult && !resolveResult.mcp.ok);

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
          placeholder={`Search ${title.toLowerCase()}…`}
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
            None available
          </Typography>
        ) : filtered.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No matches for “{search}”.
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
              Pick the entities to include. Dependencies (subflows, referenced models and
              MCP servers, planned-execution flows) are pulled in automatically in the next step.
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
                Import manifest (.json)
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
                Restores the selection, metadata and accepted secrets from a package you
                exported earlier.
              </Typography>
            </Stack>
            {importErrors.length > 0 && (
              <Alert severity="error" onClose={() => setImportErrors([])}>
                <AlertTitle>Could not import that file</AlertTitle>
                {importErrors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </Alert>
            )}
            {importedDraft && (
              <Alert severity={importedDraft.missing.length > 0 ? 'warning' : 'success'}>
                <AlertTitle>
                  Imported “{importedDraft.metadata.name}” v{importedDraft.metadata.version}
                </AlertTitle>
                Restored {importedDraft.selection.flowIds.length} flow(s),{' '}
                {importedDraft.selection.modelIds.length} model(s),{' '}
                {importedDraft.selection.mcpServerNames.length} MCP server(s),{' '}
                {importedDraft.selection.plannedExecutionIds.length} planned execution(s) and{' '}
                {importedDraft.secretNames.length} secret name(s).
                {importedDraft.missing.length > 0 && (
                  <Box sx={{ mt: 1 }}>
                    No longer on this host (left unselected):
                    {importedDraft.missing.map((m, i) => (
                      <div key={i}>
                        {m.type}: {m.label}
                      </div>
                    ))}
                  </Box>
                )}
              </Alert>
            )}
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              {renderList('Flows', entities.flows, selectedFlows, toggle(setSelectedFlows), flowSearch, setFlowSearch)}
              {renderList('Models', entities.models, selectedModels, toggle(setSelectedModels), modelSearch, setModelSearch)}
              {renderList('MCP servers', entities.mcpServers, selectedServers, toggle(setSelectedServers), serverSearch, setServerSearch)}
              {renderList('Planned executions', entities.plannedExecutions, selectedPlanned, toggle(setSelectedPlanned), plannedSearch, setPlannedSearch)}
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
                <AlertTitle>Local MCP server(s) cannot be packaged</AlertTitle>
                {resolveResult.mcp.errors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </Alert>
            )}
            {resolveResult.resolved.autoAdded.length > 0 && (
              <Alert severity="info">
                <AlertTitle>Automatically included dependencies</AlertTitle>
                {resolveResult.resolved.autoAdded.map((a, i) => (
                  <div key={i}>
                    {a.type}: <code>{a.id}</code> — {a.reason}
                  </div>
                ))}
              </Alert>
            )}
            {resolveResult.resolved.warnings.length > 0 && (
              <Alert severity="warning">
                <AlertTitle>Warnings</AlertTitle>
                {resolveResult.resolved.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </Alert>
            )}
            <Divider />
            <Typography variant="body2">
              Resolved: {resolveResult.resolved.flowIds.length} flow(s),{' '}
              {resolveResult.resolved.modelIds.length} model(s),{' '}
              {resolveResult.resolved.mcpServerNames.length} MCP server(s),{' '}
              {resolveResult.resolved.plannedExecutionIds.length} planned execution(s).
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
            <Typography variant="subtitle2">Global variables</Typography>
            <Typography variant="body2" color="text.secondary">
              Global variables referenced by the package. Add a useful description for each one;
              installers will supply values and FLUJO will create them in Global Variables.
            </Typography>
            {!resolveResult || (resolveResult.globals ?? []).length === 0 ? (
              <Alert severity="success">No global variables referenced by this package.</Alert>
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
                          ? 'Secret global; its value is never included in the package'
                          : 'Description shown during package installation'
                      }
                      fullWidth
                    />
                    {entry.isSecret && (
                      <Chip label="secret global" size="small" color="warning" variant="outlined" />
                    )}
                  </Stack>
                ))}
              </Stack>
            )}

            <Divider />

            <Typography variant="subtitle2">Declared secrets (entity keys)</Typography>
            <Typography variant="body2" color="text.secondary">
              Secrets the package will declare from model API keys and MCP env/headers.
              Values are never included — whoever installs must supply them.
            </Typography>
            {!resolveResult || resolveResult.secrets.length === 0 ? (
              <Alert severity="success">No entity secrets to declare.</Alert>
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
                      inputProps={{ 'aria-label': `Include ${s.name} in package secrets` }}
                    />
                    <ListItemText
                      primary={
                        <>
                          <code>{displaySecretName(s.name)}</code>{' '}
                          {s.required && <Chip label="required" size="small" color="warning" />}
                        </>
                      }
                      secondary={
                        excludedEntitySecrets.has(s.name)
                          ? 'Excluded — the package will not request this value'
                          : s.description
                      }
                    />
                  </ListItem>
                ))}
              </List>
            )}

            <Divider />

            <Typography variant="subtitle2">Detected secrets in content</Typography>
            <Typography variant="body2" color="text.secondary">
              Values that look secret or instance-specific (paths, repos, tokens, URLs,
              emails) found in flow prompts, node properties, model config and planned-
              execution prompts. Accepted rows are replaced with a{' '}
              <code>{'{{secret.NAME}}'}</code> placeholder everywhere they occur.
            </Typography>

            {deriving && (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                <CircularProgress size={28} />
              </Box>
            )}
            {deriveError && <Alert severity="error">{deriveError}</Alert>}

            {!deriving && derivedOnce && contentProposals.length === 0 && (
              <Alert severity="success">No likely secrets detected in the packaged content.</Alert>
            )}

            {contentProposals.length > 0 && (
              <>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {kindCounts.map(([kind, count]) => (
                    <Chip key={kind} size="small" variant="outlined" label={`${kind}: ${count}`} />
                  ))}
                </Stack>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Button size="small" onClick={() => setAllProposals(true)}>
                    Accept all
                  </Button>
                  <Button size="small" onClick={() => setAllProposals(false)}>
                    Reject all
                  </Button>
                  <TextField
                    size="small"
                    placeholder="Filter detected secrets…"
                    value={proposalFilter}
                    onChange={(e) => setProposalFilter(e.target.value)}
                    sx={{ minWidth: 200, flex: 1 }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                    {groupedProposals.filter((g) => g.accepted).length} of {groupedProposals.length} accepted
                  </Typography>
                </Stack>
                <List dense sx={{ border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: 280, overflow: 'auto' }}>
                  {filteredProposals.length === 0 && (
                    <ListItem>
                      <ListItemText
                        primary={
                          <Typography variant="body2" color="text.secondary">
                            No rows match “{proposalFilter}”.
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
                            <Chip label={g.kind} size="small" />
                            <Chip
                              label={g.source}
                              size="small"
                              variant="outlined"
                              color={g.source === 'model' ? 'secondary' : g.source === 'manual' ? 'primary' : 'default'}
                            />
                            {g.confidence && (
                              <Chip
                                label={g.confidence}
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
                                ? `${g.locations.length} locations: ${g.locations.slice(0, 3).join(', ')}${g.locations.length > 3 ? ', …' : ''}`
                                : g.locations[0]}
                              {g.rationale ? ` — ${g.rationale}` : ''}
                            </Typography>
                            <TextField
                              size="small"
                              label="Secret name"
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
                <AlertTitle>Secrets from the imported manifest that need re-adding</AlertTitle>
                A manifest never carries secret values, so these declarations could not be
                matched to anything in the current content — re-add them below if they still
                apply: {unrecoveredSecretNames.map(displaySecretName).join(', ')}.
              </Alert>
            )}

            {deriveWarnings.length > 0 && (
              <Alert severity="warning">
                <AlertTitle>Notes</AlertTitle>
                {deriveWarnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </Alert>
            )}

            <Divider />
            <Typography variant="subtitle2">Add a secret manually</Typography>
            <Typography variant="body2" color="text.secondary">
              Enter any value that should be redacted from the package. It is treated purely
              as text to replace with a <code>{'{{secret.NAME}}'}</code> placeholder — it is
              never executed.
            </Typography>
            {manualError && <Alert severity="error">{manualError}</Alert>}
            <Stack direction="row" spacing={1} alignItems="flex-start" flexWrap="wrap" useFlexGap>
              <TextField
                size="small"
                label="Value to redact"
                value={manualExcerpt}
                onChange={(e) => setManualExcerpt(e.target.value)}
                sx={{ minWidth: 240, flex: 1 }}
              />
              <TextField
                size="small"
                label="Secret name"
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
                    {k}
                  </MenuItem>
                ))}
              </Select>
              <Button variant="outlined" onClick={addManualProposal} disabled={!manualExcerpt.trim()}>
                Add
              </Button>
              <Button
                variant="text"
                startIcon={<SearchIcon />}
                onClick={() => void openValuePicker()}
                disabled={nothingSelected}
              >
                Pick from app
              </Button>
            </Stack>

            <Divider />
            <Typography variant="subtitle2">Advanced scan options</Typography>
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
                label="Aggressive entropy scan"
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
                label="Detect bare owner/repo slugs"
              />
              <Button size="small" variant="text" onClick={() => void runDerive()} disabled={deriving}>
                Re-scan
              </Button>
            </Stack>

            <Divider />
            <Typography variant="subtitle2">Optional: model-driven scan</Typography>
            <Alert severity="info">
              Running the model-driven pass sends the packaged content above to the selected
              model provider. The offline heuristic scan never leaves your machine.
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
                  <em>Select a model…</em>
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
                Scan with model
              </Button>
            </Stack>
          </Stack>
        );
      case 3:
        return (
          <Stack spacing={2}>
            <TextField
              label="Package name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              fullWidth
              error={name.length > 0 && name.trim().length === 0}
            />
            <TextField
              label="Version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              required
              fullWidth
              error={version.length > 0 && !versionValid}
              helperText={version.length > 0 && !versionValid ? 'Must be a semantic version (e.g. 1.0.0)' : ' '}
            />
            <TextField
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              fullWidth
              multiline
              minRows={2}
            />
            <TextField
              label="Tags (comma-separated)"
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
                <AlertTitle>Package built</AlertTitle>
                <code>{name.trim()}</code> v{version.trim()} is ready to export.
              </Alert>
              {buildResult.warnings.length > 0 && (
                <Alert severity="warning">
                  <AlertTitle>Warnings</AlertTitle>
                  {buildResult.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </Alert>
              )}
              <Button variant="contained" onClick={downloadManifest}>
                Download package manifest (.json)
              </Button>

              <Divider />
              <Typography variant="subtitle2">Publish to the FLUJO package registry</Typography>
              <Typography variant="body2" color="text.secondary">
                Publishing requires a confirmed registry account (set one up on the
                Packages page). Only the secret-safe manifest above
                is uploaded — no secret values ever leave your machine.
              </Typography>
              {publishResult?.ok ? (
                <Alert severity="success">
                  <AlertTitle>Published</AlertTitle>
                  {publishResult.name || name.trim()} v{publishResult.version || version.trim()} is live.
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
                      {publishResult.error || 'Failed to publish package.'}
                    </Alert>
                  )}
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Button variant="outlined" onClick={() => void publishToRegistry()} disabled={publishing}>
                      {publishing ? 'Publishing…' : 'Publish to registry'}
                    </Button>
                    {publishResult &&
                      !publishResult.ok &&
                      (publishResult.code === 'not_authenticated' || publishResult.code === 'unconfirmed') && (
                        <Button variant="contained" onClick={() => setLoginOpen(true)} disabled={publishing}>
                          Log in to registry
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
        <DialogTitle>Create package</DialogTitle>
        <DialogContent dividers sx={{ overflow: 'auto' }}>
          <Stepper activeStep={activeStep} sx={{ mb: 3 }}>
            {STEPS.map((label) => (
              <Step key={label}>
                <StepLabel>{label}</StepLabel>
              </Step>
            ))}
          </Stepper>
          {renderStepContent()}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{buildResult?.ok ? 'Close' : 'Cancel'}</Button>
          <Box sx={{ flex: 1 }} />
          <Button onClick={handleBack} disabled={activeStep === 0 || building || resolving}>
            Back
          </Button>
          {activeStep < 4 && (
            <Button variant="contained" onClick={handleNext} disabled={nextDisabled}>
              {activeStep === 3 ? 'Build' : 'Next'}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={loginOpen} onClose={() => setLoginOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Log in to the package registry</DialogTitle>
        <DialogContent dividers>
          <RegistryAccountSettings />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLoginOpen(false)}>Done</Button>
          <Button
            variant="contained"
            onClick={() => {
              setLoginOpen(false);
              void publishToRegistry();
            }}
            disabled={publishing}
          >
            Retry publish
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={pickerOpen} onClose={() => setPickerOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Pick a value to redact</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            These are plaintext values found in the packaged flows, models and planned
            executions. Pick one to pre-fill the value to redact. API keys and MCP
            env/header values are never listed — they are already declared as secrets.
          </Typography>
          <TextField
            size="small"
            fullWidth
            placeholder="Search values…"
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
            <Alert severity="info">No pickable plaintext values found in the packaged content.</Alert>
          ) : filteredCandidates.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No values match “{pickerSearch}”.
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
                          <Chip label={c.source} size="small" variant="outlined" />
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
          <Button onClick={() => setPickerOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
