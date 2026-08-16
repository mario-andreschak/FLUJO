"use client";

import {
  AddRounded,
  RefreshRounded,
} from '@mui/icons-material';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  LinearProgress,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import FlowCard from '@/frontend/components/Flow/FlowDashboard/FlowCard';
import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';
import { useMcpAppsDiscovery } from '@/frontend/components/mcp/useMcpAppsDiscovery';
import CardPickerGrid from '@/frontend/components/shared/CardPickerGrid';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { flowService } from '@/frontend/services/flow';
import {
  PersonasApiError,
  personasService,
  type PersonaBundle,
  type RolesResponse,
} from '@/frontend/services/personas';
import type { Flow } from '@/frontend/types/flow/flow';
import { personaFlowBuilderUrl } from '@/frontend/utils/personaFlowNavigation';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type {
  PersonaCreationDraft,
  PersonaCreationDraftPayload,
  PersonaFlowReadiness,
} from '@/shared/types/enduringAgent';

import RoleVersionCard from './RoleVersionCard';

interface PersonaCreationWizardProps {
  open: boolean;
  draft?: PersonaCreationDraft | null;
  onClose: () => void;
  onCreated: (detail: PersonaBundle) => void;
  onDraftSaved: (draft: PersonaCreationDraft) => void;
  onDraftDiscarded: (draftId: string) => void;
}

const EMPTY_READINESS: PersonaFlowReadiness = { state: 'missing', issues: [] };

function rolePickerVersions(
  response: RolesResponse | null,
  selectedRoleVersionId = '',
): RolesResponse['roleVersions'] {
  if (!response) return [];
  const currentVersionByDefinition = new Map(
    response.roleDefinitions.map((definition) => [definition.id, definition.currentVersionId]),
  );
  const versionsByDefinition = new Map<string, RolesResponse['roleVersions']>();
  for (const version of response.roleVersions) {
    const versions = versionsByDefinition.get(version.roleDefinitionId) ?? [];
    versions.push(version);
    versionsByDefinition.set(version.roleDefinitionId, versions);
  }
  return [...versionsByDefinition.values()].flatMap((versions) => {
    const selected = versions.find((version) => version.id === selectedRoleVersionId);
    if (selected) return [selected];
    const currentId = currentVersionByDefinition.get(versions[0].roleDefinitionId);
    const current = versions.find((version) => version.id === currentId);
    if (current) return [current];
    return [[...versions].sort(
      (left, right) => right.version - left.version || right.createdAt - left.createdAt,
    )[0]];
  });
}

function suggestedMcpServerRefs(
  role: RolesResponse['roleVersions'][number] | undefined,
): string[] {
  if (!role) return [];
  const refs = role.suggestedApps !== undefined
    ? role.suggestedApps.map((app) => app.mcpServerName)
    : role.capabilityRequirements?.preferredMcpServers ?? [];
  return Array.from(new Set(refs));
}

function validOptionalUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function PersonaCreationWizard({
  open,
  draft,
  onClose,
  onCreated,
  onDraftSaved,
  onDraftDiscarded,
}: PersonaCreationWizardProps) {
  const { t } = useI18n();
  const tRef = useRef(t);
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [step, setStep] = useState(0);
  const [roles, setRoles] = useState<RolesResponse | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [name, setName] = useState('');
  const [mission, setMission] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [roleVersionId, setRoleVersionId] = useState('');
  const [coreFlowRef, setCoreFlowRef] = useState('');
  const [behaviorFlowRefs, setBehaviorFlowRefs] = useState<string[]>([]);
  const [appRefs, setAppRefs] = useState<string[]>([]);
  const [appsEdited, setAppsEdited] = useState(false);
  const [memories, setMemories] = useState(['']);
  const [idempotencyKey, setIdempotencyKey] = useState(() => uuidv4());
  const [readiness, setReadiness] = useState<Record<string, PersonaFlowReadiness>>({});
  const [loadingReadiness, setLoadingReadiness] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [draftRecord, setDraftRecord] = useState<PersonaCreationDraft | null>(null);
  const [roleRefreshError, setRoleRefreshError] = useState<string | null>(null);
  const roleRequestRef = useRef<{ sequence: number; controller: AbortController | null }>({
    sequence: 0,
    controller: null,
  });
  const lastRoleRefreshAtRef = useRef(0);
  const hydratingDraftIdRef = useRef<string | null>(null);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const {
    servers: appServers,
    loading: appsLoading,
    refreshing: appsRefreshing,
    error: appsError,
    refresh: refreshApps,
  } = useMcpAppsDiscovery({ active: open, includeAllServers: true });

  const steps = useMemo(() => [
    t('personas.create.step.identity'),
    t('personas.create.step.role'),
    t('personas.create.step.apps'),
    t('personas.create.step.behaviors'),
    t('personas.create.step.review'),
  ], [t]);

  const selectedRole = roles?.roleVersions.find((role) => role.id === roleVersionId);
  const draftPinnedRoleVersionId = draft?.payload.roleVersionId === roleVersionId
    ? roleVersionId
    : '';
  const selectableRoles = useMemo(
    () => rolePickerVersions(roles, draftPinnedRoleVersionId),
    [draftPinnedRoleVersionId, roles],
  );
  const selectedRoleUnavailable = Boolean(roleVersionId && roles && !selectedRole);
  const selectedCore = flows.find((flow) => flow.id === coreFlowRef);
  const primaryRoleBehavior = selectedRole?.behaviorSlots.find((slot) => slot.key === 'primary');
  const roleDefaultCore = selectedRole?.coreFlowTemplate ?? primaryRoleBehavior?.flowTemplate;
  const effectiveCore = selectedCore ?? roleDefaultCore;
  const selectedBehaviors = flows.filter((flow) => behaviorFlowRefs.includes(flow.id));
  const requiredBehaviorCount = selectedRole?.behaviorSlots.length ?? 0;
  const initialMemories = memories.map((value) => value.trim()).filter(Boolean);
  const avatarValid = validOptionalUrl(avatarUrl);
  const dirty = Boolean(
    name || mission || avatarUrl || roleVersionId || coreFlowRef
    || behaviorFlowRefs.length || appRefs.length || initialMemories.length,
  );

  const reset = () => {
    roleRequestRef.current.controller?.abort();
    setStep(0);
    setRoles(null);
    setFlows([]);
    setName('');
    setMission('');
    setAvatarUrl('');
    setRoleVersionId('');
    setCoreFlowRef('');
    setBehaviorFlowRefs([]);
    setAppRefs([]);
    setAppsEdited(false);
    setMemories(['']);
    setReadiness({});
    setLoadingReadiness(new Set());
    setError(null);
    setStatus(null);
    setRoleRefreshError(null);
    setDraftRecord(null);
    hydratingDraftIdRef.current = null;
    setIdempotencyKey(uuidv4());
  };

  useEffect(() => {
    if (!open || !draft) return;
    // Effects below still see the pre-hydration render. Mark this draft before
    // restoring state so default App synchronization skips that stale pass.
    hydratingDraftIdRef.current = draft.id;
    setDraftRecord(draft);
    // Older seven-step drafts map safely into the five-step default flow.
    setStep(Math.min(draft.payload.step, 4));
    setName(draft.payload.name);
    setMission(draft.payload.mission);
    setAvatarUrl(draft.payload.avatarUrl);
    setRoleVersionId(draft.payload.roleVersionId);
    setCoreFlowRef(draft.payload.coreFlowRef);
    setBehaviorFlowRefs(draft.payload.behaviorFlowRefs);
    setAppRefs(draft.payload.appRefs);
    setAppsEdited(draft.payload.appsEdited);
    setMemories(draft.payload.memories.length ? draft.payload.memories : ['']);
    setIdempotencyKey(draft.payload.idempotencyKey);
    setStatus(t('personas.create.draftResumed'));
  }, [draft, open, t]);

  const refreshRoles = useCallback(async (
    initialize = false,
    force = false,
  ): Promise<void> => {
    const now = Date.now();
    if (!force && !initialize && now - lastRoleRefreshAtRef.current < 250) return;
    lastRoleRefreshAtRef.current = now;

    roleRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const sequence = roleRequestRef.current.sequence + 1;
    roleRequestRef.current = { sequence, controller };
    setRoleRefreshError(null);

    try {
      const nextRoles = await personasService.roles(controller.signal);
      if (
        controller.signal.aborted
        || sequence !== roleRequestRef.current.sequence
      ) return;
      setRoles(nextRoles);
      if (initialize) {
        setRoleVersionId((current) => current || rolePickerVersions(nextRoles)[0]?.id || '');
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message = cause instanceof Error
        ? cause.message
        : tRef.current('personas.create.refreshRolesFailed');
      setRoleRefreshError(message);
      throw cause;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      roleRequestRef.current.controller?.abort();
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      refreshRoles(true),
      flowService.loadFlows(),
    ])
      .then(([, nextFlows]) => {
        if (cancelled) return;
        const sharedFlows = nextFlows.filter((flow) => !flow.personaOwnership);
        setFlows(sharedFlows);
      })
      .catch((cause) => {
        if (cancelled || roleRequestRef.current.controller?.signal.aborted) return;
        setError(cause instanceof Error
          ? cause.message
          : tRef.current('personas.action.failed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      roleRequestRef.current.controller?.abort();
    };
  }, [open, refreshRoles]);

  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      void refreshRoles(false).catch(() => undefined);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [open, refreshRoles]);

  useEffect(() => {
    if (!open) return;
    if (draft && hydratingDraftIdRef.current === draft.id) {
      hydratingDraftIdRef.current = null;
      return;
    }
    if (appsEdited) return;
    const preferred = new Set(suggestedMcpServerRefs(selectedRole));
    const eligible = new Set(appServers.map((server) => server.name));
    const next = [...preferred].filter((ref) => eligible.has(ref));
    setAppRefs((current) => (
      current.length === next.length
      && current.every((ref, index) => ref === next[index])
        ? current
        : next
    ));
  }, [appServers, appsEdited, draft, open, selectedRole]);

  const wasOnAppsStepRef = useRef(false);
  useEffect(() => {
    const enteringApps = open && step === 2 && !wasOnAppsStepRef.current;
    wasOnAppsStepRef.current = open && step === 2;
    if (enteringApps) refreshApps();
  }, [open, refreshApps, step]);

  const refsToCheck = useMemo(
    () => [coreFlowRef, ...behaviorFlowRefs].filter(Boolean),
    [behaviorFlowRefs, coreFlowRef],
  );

  useEffect(() => {
    if (!open) return;
    const missing = refsToCheck.filter(
      (ref) => !readiness[ref] && !loadingReadiness.has(ref),
    );
    if (missing.length === 0) return;
    setLoadingReadiness((current) => new Set([...current, ...missing]));
    void Promise.all(missing.map(async (ref) => {
      try {
        return [ref, await personasService.flowReadiness(ref)] as const;
      } catch (cause) {
        return [ref, {
          state: 'invalid' as const,
          issues: [cause instanceof Error ? cause.message : t('personas.create.readinessFailed')],
        }] as const;
      }
    })).then((results) => {
      setReadiness((current) => Object.fromEntries([
        ...Object.entries(current),
        ...results,
      ]));
      setLoadingReadiness((current) => {
        const next = new Set(current);
        missing.forEach((ref) => next.delete(ref));
        return next;
      });
    });
  }, [loadingReadiness, open, readiness, refsToCheck, t]);

  const setRole = (id: string) => {
    setRoleVersionId(id);
    setAppsEdited(false);
  };

  const toggleBehavior = (id: string) => {
    setBehaviorFlowRefs((current) => current.includes(id)
      ? current.filter((ref) => ref !== id)
      : [...current, id]);
  };

  const toggleApp = (name: string) => {
    setAppsEdited(true);
    setAppRefs((current) => current.includes(name)
      ? current.filter((ref) => ref !== name)
      : [...current, name]);
  };

  const flowReady = (ref: string) => readiness[ref]?.state === 'ready';
  const stepValid = [
    Boolean(name.trim()) && avatarValid,
    Boolean(selectedRole),
    true,
    behaviorFlowRefs.every(flowReady),
    Boolean(name.trim() && selectedRole && effectiveCore)
      && (!coreFlowRef || flowReady(coreFlowRef))
      && behaviorFlowRefs.every(flowReady),
  ][step];

  const draftPayload = (): PersonaCreationDraftPayload => ({
    step,
    name,
    mission,
    avatarUrl,
    roleVersionId,
    coreFlowRef,
    behaviorFlowRefs,
    appRefs,
    appsEdited,
    memories,
    idempotencyKey,
  });

  const saveDraft = async () => {
    setSavingDraft(true);
    setError(null);
    setStatus(t('personas.create.savingDraft'));
    try {
      const payload = draftPayload();
      const saved = draftRecord
        ? await personasService.updateDraft(draftRecord.id, {
            expectedRevision: draftRecord.revision,
            payload,
          })
        : await personasService.createDraft({
            // The final-create key is stable for this wizard session, so a
            // transient POST retry addresses the same draft record.
            id: `draft_${idempotencyKey.replaceAll('-', '')}`,
            payload,
          });
      setDraftRecord(saved);
      setStatus(t('personas.create.draftSaved'));
      reset();
      onDraftSaved(saved);
    } catch (cause) {
      const message = cause instanceof PersonasApiError && cause.status === 409
        ? t('personas.create.draftConflict')
        : cause instanceof Error
          ? cause.message
          : t('personas.create.draftSaveFailed');
      setError(message);
      setStatus(null);
    } finally {
      setSavingDraft(false);
    }
  };

  const discardAndClose = async () => {
    setSavingDraft(true);
    setError(null);
    try {
      if (draftRecord) {
        await personasService.deleteDraft(draftRecord.id, {
          expectedRevision: draftRecord.revision,
        });
        onDraftDiscarded(draftRecord.id);
      }
      setConfirmCancel(false);
      reset();
      onClose();
    } catch (cause) {
      setConfirmCancel(false);
      setError(cause instanceof PersonasApiError && cause.status === 409
        ? t('personas.create.draftConflict')
        : cause instanceof Error
          ? cause.message
          : t('personas.create.draftDiscardFailed'));
    } finally {
      setSavingDraft(false);
    }
  };

  const requestClose = () => {
    if (saving || savingDraft) return;
    if (dirty) setConfirmCancel(true);
    else {
      reset();
      onClose();
    }
  };

  const submit = async () => {
    if (!stepValid || !selectedRole || !effectiveCore) return;
    setSaving(true);
    setError(null);
    try {
      const detail = await personasService.create({
        name: name.trim(),
        roleVersionId,
        appRefs,
        behaviorFlowRefs,
        ...(coreFlowRef ? { coreFlowRef } : {}),
        ...(mission.trim() ? { mission: mission.trim() } : {}),
        ...(avatarUrl.trim() ? { presentation: { avatarUrl: avatarUrl.trim() } } : {}),
        idempotencyKey,
        ...(initialMemories.length
          ? { initialMemories: initialMemories.map((content) => ({ content })) }
          : {}),
      });
      if (draftRecord) {
        try {
          await personasService.deleteDraft(draftRecord.id, {
            expectedRevision: draftRecord.revision,
          });
          onDraftDiscarded(draftRecord.id);
        } catch {
          // Persona creation succeeded; draft cleanup must never trigger a duplicate publish retry.
        }
      }
      reset();
      onCreated(detail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('personas.action.failed'));
    } finally {
      setSaving(false);
    }
  };

  const builderHref = (flowRef: string) => personaFlowBuilderUrl(
    flowRef,
    '/personas?create=1',
  );

  return (
    <>
      <Dialog
        open={open}
        onClose={requestClose}
        fullScreen={fullScreen}
        fullWidth
        maxWidth="lg"
        aria-labelledby="persona-create-title"
      >
        <DialogTitle id="persona-create-title">{t('personas.create.title')}</DialogTitle>
        {loading && <LinearProgress />}
        <DialogContent dividers>
          <Stack spacing={3}>
            <Stepper activeStep={step} alternativeLabel={!fullScreen} orientation={fullScreen ? 'vertical' : 'horizontal'}>
              {steps.map((label) => <Step key={label}><StepLabel>{label}</StepLabel></Step>)}
            </Stepper>
            {error && <Alert severity="error" role="alert">{error}</Alert>}
            {status && <Alert severity="info" role="status" aria-live="polite">{status}</Alert>}
            {roleRefreshError && (
              <Alert
                severity="warning"
                action={(
                  <Button onClick={() => void refreshRoles(false, true).catch(() => undefined)}>
                    {t('personas.create.refreshRoles')}
                  </Button>
                )}
              >
                {roleRefreshError}
              </Alert>
            )}
            {selectedRoleUnavailable && (
              <Alert severity="warning" role="alert">
                {t('personas.create.roleUnavailable')}
              </Alert>
            )}

            {step === 0 && (
              <Stack spacing={2}>
                <Typography variant="h5">{t('personas.create.identity.title')}</Typography>
                <Typography color="text.secondary">{t('personas.create.identity.help')}</Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
                  <Avatar src={avatarUrl || undefined} sx={{ width: 88, height: 88 }}>
                    {name.trim().slice(0, 1).toUpperCase()}
                  </Avatar>
                  <Stack spacing={2} flex={1}>
                    <TextField autoFocus required label={t('personas.create.name')} value={name} onChange={(event) => setName(event.target.value)} />
                    <TextField label={t('personas.create.picture')} helperText={avatarValid ? t('personas.create.pictureHelp') : t('personas.create.pictureInvalid')} error={!avatarValid} value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} />
                  </Stack>
                </Stack>
                <TextField label={t('personas.create.purpose')} helperText={t('personas.create.purposeHelp')} value={mission} onChange={(event) => setMission(event.target.value)} multiline minRows={2} />
              </Stack>
            )}

            {step === 1 && (
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h5">{t('personas.create.roleTitle')}</Typography>
                  <Typography color="text.secondary">{t('personas.create.roleHelp')}</Typography>
                </Box>
                <CardPickerGrid
                  searchable
                  selectionMode="single"
                  ariaLabel={t('personas.create.roleTitle')}
                  isLoading={!roles && loading}
                  items={selectableRoles.map((role) => ({
                    key: role.id,
                    label: role.name,
                    selected: roleVersionId === role.id,
                    searchText: `${role.name} ${role.mission}`,
                    onSelect: () => setRole(role.id),
                    content: <RoleVersionCard role={role} selected={roleVersionId === role.id} plainLanguage onSelect={() => {}} />,
                  }))}
                />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <Button component={Link} href={withWorkspaceUrl('/roles/new')} target="_blank" startIcon={<AddRounded />}>{t('personas.create.newRole')}</Button>
                  <Button startIcon={<RefreshRounded />} onClick={() => void refreshRoles(false, true).catch(() => undefined)}>{t('personas.create.refreshRoles')}</Button>
                </Stack>
              </Stack>
            )}

            {step === 3 && (
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h5">{t('personas.create.behaviorsTitle')}</Typography>
                  <Typography color="text.secondary">{t('personas.create.behaviorsHelp')}</Typography>
                </Box>
                {selectedBehaviors.map((flow) => readiness[flow.id]?.state !== 'ready' && (
                  <ReadinessNotice key={flow.id} readiness={readiness[flow.id] ?? EMPTY_READINESS} loading={loadingReadiness.has(flow.id)} repairHref={builderHref(flow.id)} name={flow.name} />
                ))}
                <CardPickerGrid
                  searchable
                  selectionMode="multiple"
                  ariaLabel={t('personas.create.behaviorsTitle')}
                  items={flows.filter((flow) => flow.id !== coreFlowRef).map((flow) => ({
                    key: flow.id,
                    label: flow.name,
                    selected: behaviorFlowRefs.includes(flow.id),
                    searchText: `${flow.name} ${flow.description ?? ''}`,
                    onSelect: () => toggleBehavior(flow.id),
                    content: <FlowCard flow={flow} selected={behaviorFlowRefs.includes(flow.id)} pickerMode selectionManaged onSelect={() => {}} />,
                  }))}
                />
              </Stack>
            )}

            {step === 2 && (
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h5">{t('personas.create.appsTitle')}</Typography>
                  <Typography color="text.secondary">{t('personas.create.appsHelp')}</Typography>
                </Box>
                {appsError && <Alert severity="warning">{appsError}</Alert>}
                <Box
                  sx={{
                    border: 1,
                    borderColor: appRefs.length ? 'primary.main' : 'divider',
                    bgcolor: appRefs.length ? 'primary.main' : 'transparent',
                    color: appRefs.length ? 'primary.contrastText' : 'text.secondary',
                    borderRadius: 2.5,
                    px: 2,
                    py: 1.5,
                  }}
                  aria-live="polite"
                >
                  <Typography variant="subtitle2" fontWeight={750}>
                    {t('personas.create.appsSelected', { count: appRefs.length })}
                  </Typography>
                  {appRefs.length > 0 && (
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                      {appRefs.map((ref) => (
                        <Chip
                          key={ref}
                          label={ref}
                          color="default"
                          onDelete={() => toggleApp(ref)}
                          sx={{ bgcolor: 'background.paper', color: 'text.primary', fontWeight: 650 }}
                        />
                      ))}
                    </Stack>
                  )}
                </Box>
                <Button
                  sx={{ alignSelf: 'flex-start' }}
                  startIcon={<RefreshRounded />}
                  disabled={appsLoading || appsRefreshing}
                  onClick={refreshApps}
                >
                  {t('personas.create.refreshApps')}
                </Button>
                <CardPickerGrid
                  searchable
                  selectionMode="multiple"
                  ariaLabel={t('personas.create.appsTitle')}
                  isLoading={appsLoading || appsRefreshing}
                  emptyMessage={t('personas.apps.noEligible')}
                  items={appServers.map((server) => ({
                    key: server.name,
                    label: server.name,
                    selected: appRefs.includes(server.name),
                    searchText: `${server.name} ${server.config?.rootPath ?? ''}`,
                    onSelect: () => toggleApp(server.name),
                    content: <ServerCard name={server.name} status={server.error ? 'error' : 'connected'} path={server.config?.rootPath ?? ''} enabled={server.config ? !server.config.disabled : true} transport={server.config?.transport ?? 'stdio'} pickerMode selectionManaged selected={appRefs.includes(server.name)} serverConfig={server.config} onClick={() => {}} />,
                  }))}
                />
              </Stack>
            )}

            {step === 4 && (
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h5">{t('personas.create.reviewTitle')}</Typography>
                  <Typography color="text.secondary">{t('personas.create.reviewHelp')}</Typography>
                </Box>
                <Typography>{t('personas.create.reviewIdentity', { name: name.trim(), purpose: mission.trim() || t('personas.create.noPurpose') })}</Typography>
                <Typography>{t('personas.create.reviewRole', { role: selectedRole?.name ?? '' })}</Typography>
                <Typography>
                  {selectedCore
                    ? t('personas.create.reviewCoreOwned', { flow: selectedCore.name })
                    : t('personas.create.reviewCoreFromRole', {
                        flow: selectedRole?.coreFlowTemplate?.name
                          ?? primaryRoleBehavior?.name
                          ?? roleDefaultCore?.name
                          ?? '',
                      })}
                </Typography>
                {coreFlowRef && readiness[coreFlowRef]?.state !== 'ready' && (
                  <ReadinessNotice
                    readiness={readiness[coreFlowRef] ?? EMPTY_READINESS}
                    loading={loadingReadiness.has(coreFlowRef)}
                    repairHref={builderHref(coreFlowRef)}
                    name={selectedCore?.name}
                  />
                )}
                <Typography>
                  {t('personas.create.reviewRequiredBehaviors', {
                    count: requiredBehaviorCount,
                    flows: selectedRole?.behaviorSlots.map((slot) => slot.name).join(', ') ?? '',
                  })}
                </Typography>
                <Typography>{selectedBehaviors.length ? t('personas.create.reviewSupplementalBehaviors', { count: selectedBehaviors.length, flows: selectedBehaviors.map((flow) => flow.name).join(', ') }) : t('personas.create.reviewNoSupplementalBehaviors')}</Typography>
                <Typography>{t('personas.create.reviewBehaviorTotal', { count: requiredBehaviorCount + selectedBehaviors.length })}</Typography>
                <Typography>{appRefs.length ? t('personas.create.reviewApps', { apps: appRefs.join(', ') }) : t('personas.create.reviewNoApps')}</Typography>
                <Typography color="text.secondary">{t('personas.create.memoryPostCreate')}</Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {avatarUrl && <Chip avatar={<Avatar src={avatarUrl} />} label={t('personas.create.pictureChosen')} />}
                  <Chip color="success" label={t('personas.create.ready')} />
                </Stack>
              </Stack>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ justifyContent: 'space-between', px: 3 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button disabled={saving || savingDraft} onClick={requestClose}>{t('personas.action.cancel')}</Button>
            <Button variant="outlined" disabled={saving || savingDraft} onClick={() => void saveDraft()}>
              {savingDraft ? t('personas.create.savingDraft') : t('personas.create.saveDraft')}
            </Button>
          </Stack>
          <Stack direction="row" spacing={1}>
            {step > 0 && <Button disabled={saving || savingDraft} onClick={() => setStep((current) => current - 1)}>{t('personas.create.back')}</Button>}
            {step < steps.length - 1 ? (
              <Button variant="contained" disabled={!stepValid || saving || savingDraft} onClick={() => setStep((current) => current + 1)}>
                {((step === 2 && appRefs.length === 0)
                  || (step === 3 && behaviorFlowRefs.length === 0))
                  ? t('personas.create.skip')
                  : t('personas.create.next')}
              </Button>
            ) : (
              <Button variant="contained" disabled={!stepValid || saving || savingDraft} onClick={() => void submit()}>
                {saving ? t('personas.create.creating') : t('personas.create.finish')}
              </Button>
            )}
          </Stack>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmCancel} onClose={() => setConfirmCancel(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('personas.create.cancelTitle')}</DialogTitle>
        <DialogContent><Typography>{t('personas.create.cancelHelp')}</Typography></DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmCancel(false)}>{t('personas.create.keepEditing')}</Button>
          <Button color="error" disabled={savingDraft} onClick={() => void discardAndClose()}>{draftRecord ? t('personas.create.discardDraft') : t('personas.create.discard')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function ReadinessNotice({
  readiness,
  loading,
  repairHref,
  name,
}: {
  readiness: PersonaFlowReadiness;
  loading: boolean;
  repairHref: string;
  name?: string;
}) {
  const { t } = useI18n();
  if (loading) return <Alert severity="info">{t('personas.create.checkingFlow', { name: name ?? '' })}</Alert>;
  if (readiness.state === 'ready') return <Alert severity="success">{t('personas.create.flowReady')}</Alert>;
  return (
    <Alert
      severity="warning"
      action={<Button component={Link} href={repairHref} target="_blank">{t('personas.create.repairFlow')}</Button>}
    >
      <Typography fontWeight={700}>{t('personas.create.flowNeedsAttention', { name: name ?? '' })}</Typography>
      {readiness.issues.map((issue) => <Typography key={issue} variant="body2">{issue}</Typography>)}
    </Alert>
  );
}
