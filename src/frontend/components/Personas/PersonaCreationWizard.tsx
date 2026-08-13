"use client";

import {
  AddRounded,
  DeleteOutlineRounded,
  OpenInNewRounded,
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
import { useEffect, useMemo, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import FlowCard from '@/frontend/components/Flow/FlowDashboard/FlowCard';
import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';
import { useMcpAppsDiscovery } from '@/frontend/components/mcp/useMcpAppsDiscovery';
import CardPickerGrid from '@/frontend/components/shared/CardPickerGrid';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { flowService } from '@/frontend/services/flow';
import {
  personasService,
  type PersonaBundle,
  type RolesResponse,
} from '@/frontend/services/personas';
import type { Flow } from '@/frontend/types/flow/flow';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type { PersonaFlowReadiness } from '@/shared/types/enduringAgent';

import RoleVersionCard from './RoleVersionCard';

interface PersonaCreationWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (detail: PersonaBundle) => void;
}

const EMPTY_READINESS: PersonaFlowReadiness = { state: 'missing', issues: [] };

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
  onClose,
  onCreated,
}: PersonaCreationWizardProps) {
  const { t } = useI18n();
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
  const [loading, setLoading] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    servers: appServers,
    loading: appsLoading,
    error: appsError,
  } = useMcpAppsDiscovery({ active: open });

  const steps = useMemo(() => [
    t('personas.create.step.identity'),
    t('personas.create.step.role'),
    t('personas.create.step.core'),
    t('personas.create.step.behaviors'),
    t('personas.create.step.apps'),
    t('personas.create.step.memories'),
    t('personas.create.step.review'),
  ], [t]);

  const selectedRole = roles?.roleVersions.find((role) => role.id === roleVersionId);
  const selectedCore = flows.find((flow) => flow.id === coreFlowRef);
  const selectedBehaviors = flows.filter((flow) => behaviorFlowRefs.includes(flow.id));
  const selectedApps = appServers.filter((server) => appRefs.includes(server.name));
  const initialMemories = memories.map((value) => value.trim()).filter(Boolean);
  const avatarValid = validOptionalUrl(avatarUrl);
  const dirty = Boolean(
    name || mission || avatarUrl || roleVersionId || coreFlowRef
    || behaviorFlowRefs.length || appRefs.length || initialMemories.length,
  );

  const reset = () => {
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
    setIdempotencyKey(uuidv4());
  };

  useEffect(() => {
    if (!open || roles || loading) return;
    setLoading(true);
    setError(null);
    void Promise.all([personasService.roles(), flowService.loadFlows()])
      .then(([nextRoles, nextFlows]) => {
        const sharedFlows = nextFlows.filter((flow) => !flow.personaOwnership);
        setRoles(nextRoles);
        setFlows(sharedFlows);
        setRoleVersionId((current) => current || nextRoles.roleVersions[0]?.id || '');
        setCoreFlowRef((current) => current || sharedFlows[0]?.id || '');
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : t('personas.action.failed'));
      })
      .finally(() => setLoading(false));
  }, [loading, open, roles, t]);

  useEffect(() => {
    if (!open || appsEdited) return;
    const preferred = new Set(
      selectedRole?.capabilityRequirements?.preferredMcpServers ?? [],
    );
    const eligible = new Set(appServers.map((server) => server.name));
    const next = [...preferred].filter((ref) => eligible.has(ref));
    setAppRefs((current) => (
      current.length === next.length
      && current.every((ref, index) => ref === next[index])
        ? current
        : next
    ));
  }, [appServers, appsEdited, open, selectedRole]);

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
    Boolean(roleVersionId),
    Boolean(coreFlowRef) && flowReady(coreFlowRef),
    behaviorFlowRefs.every(flowReady),
    true,
    true,
    Boolean(name.trim() && roleVersionId && coreFlowRef)
      && flowReady(coreFlowRef)
      && behaviorFlowRefs.every(flowReady),
  ][step];

  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirmCancel(true);
    else {
      reset();
      onClose();
    }
  };

  const submit = async () => {
    if (!stepValid || !selectedRole || !selectedCore) return;
    setSaving(true);
    setError(null);
    try {
      const detail = await personasService.create({
        name: name.trim(),
        coreFlowRef,
        roleVersionId,
        appRefs,
        behaviorFlowRefs,
        ...(mission.trim() ? { mission: mission.trim() } : {}),
        ...(avatarUrl.trim() ? { presentation: { avatarUrl: avatarUrl.trim() } } : {}),
        idempotencyKey,
        ...(initialMemories.length
          ? { initialMemories: initialMemories.map((content) => ({ content })) }
          : {}),
      });
      reset();
      onCreated(detail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('personas.action.failed'));
    } finally {
      setSaving(false);
    }
  };

  const builderHref = (flowRef?: string) => withWorkspaceUrl(
    flowRef
      ? `/flows?flow=${encodeURIComponent(flowRef)}&mode=edit`
      : '/flows',
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
            {error && <Alert severity="error">{error}</Alert>}

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
                  items={(roles?.roleVersions ?? []).map((role) => ({
                    key: role.id,
                    label: role.name,
                    selected: roleVersionId === role.id,
                    searchText: `${role.name} ${role.mission}`,
                    onSelect: () => setRole(role.id),
                    content: <RoleVersionCard role={role} selected={roleVersionId === role.id} plainLanguage onSelect={() => {}} />,
                  }))}
                />
                <Button component={Link} href={withWorkspaceUrl('/roles/new')} target="_blank" startIcon={<AddRounded />}>{t('personas.create.newRole')}</Button>
              </Stack>
            )}

            {step === 2 && (
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h5">{t('personas.create.coreTitle')}</Typography>
                  <Typography color="text.secondary">{t('personas.create.coreHelp')}</Typography>
                </Box>
                {coreFlowRef && <ReadinessNotice readiness={readiness[coreFlowRef] ?? EMPTY_READINESS} loading={loadingReadiness.has(coreFlowRef)} repairHref={builderHref(coreFlowRef)} />}
                <CardPickerGrid
                  searchable
                  selectionMode="single"
                  ariaLabel={t('personas.create.coreTitle')}
                  items={flows.map((flow) => ({
                    key: flow.id,
                    label: flow.name,
                    selected: coreFlowRef === flow.id,
                    searchText: `${flow.name} ${flow.description ?? ''}`,
                    onSelect: () => {
                      setCoreFlowRef(flow.id);
                      setBehaviorFlowRefs((current) => current.filter((ref) => ref !== flow.id));
                    },
                    content: <FlowCard flow={flow} selected={coreFlowRef === flow.id} pickerMode selectionManaged onSelect={() => {}} />,
                  }))}
                />
                <Stack direction="row" spacing={1}>
                  <Button component={Link} href={builderHref()} target="_blank" startIcon={<AddRounded />}>{t('personas.create.newFlow')}</Button>
                  {coreFlowRef && <Button component={Link} href={builderHref(coreFlowRef)} target="_blank" startIcon={<OpenInNewRounded />}>{t('personas.create.openBuilder')}</Button>}
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

            {step === 4 && (
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h5">{t('personas.create.appsTitle')}</Typography>
                  <Typography color="text.secondary">{t('personas.create.appsHelp')}</Typography>
                </Box>
                {appsError && <Alert severity="warning">{appsError}</Alert>}
                <CardPickerGrid
                  searchable
                  selectionMode="multiple"
                  ariaLabel={t('personas.create.appsTitle')}
                  isLoading={appsLoading}
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

            {step === 5 && (
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h5">{t('personas.create.memoriesTitle')}</Typography>
                  <Typography color="text.secondary">{t('personas.create.memoriesHelp')}</Typography>
                </Box>
                {memories.map((memory, index) => (
                  <Stack key={index} direction="row" spacing={1} alignItems="flex-start">
                    <TextField fullWidth multiline minRows={2} label={t('personas.create.memory', { number: index + 1 })} value={memory} onChange={(event) => setMemories((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value))} />
                    <Button aria-label={t('personas.create.removeMemory')} disabled={memories.length === 1 && !memory} onClick={() => setMemories((current) => current.length === 1 ? [''] : current.filter((_, itemIndex) => itemIndex !== index))}><DeleteOutlineRounded /></Button>
                  </Stack>
                ))}
                <Button disabled={memories.length >= 100} startIcon={<AddRounded />} onClick={() => setMemories((current) => [...current, ''])}>{t('personas.create.addMemory')}</Button>
              </Stack>
            )}

            {step === 6 && (
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h5">{t('personas.create.reviewTitle')}</Typography>
                  <Typography color="text.secondary">{t('personas.create.reviewHelp')}</Typography>
                </Box>
                <Typography>{t('personas.create.reviewIdentity', { name: name.trim(), purpose: mission.trim() || t('personas.create.noPurpose') })}</Typography>
                <Typography>{t('personas.create.reviewRole', { role: selectedRole?.name ?? '' })}</Typography>
                <Typography>{t('personas.create.reviewCore', { flow: selectedCore?.name ?? '' })}</Typography>
                <Typography>{selectedBehaviors.length ? t('personas.create.reviewBehaviors', { flows: selectedBehaviors.map((flow) => flow.name).join(', ') }) : t('personas.create.reviewNoBehaviors')}</Typography>
                <Typography>{selectedApps.length ? t('personas.create.reviewApps', { apps: selectedApps.map((server) => server.name).join(', ') }) : t('personas.create.reviewNoApps')}</Typography>
                <Typography>{initialMemories.length ? t('personas.create.reviewMemories', { count: initialMemories.length }) : t('personas.create.reviewNoMemories')}</Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {avatarUrl && <Chip avatar={<Avatar src={avatarUrl} />} label={t('personas.create.pictureChosen')} />}
                  <Chip color="success" label={t('personas.create.ready')} />
                </Stack>
              </Stack>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ justifyContent: 'space-between', px: 3 }}>
          <Button disabled={saving} onClick={requestClose}>{t('personas.action.cancel')}</Button>
          <Stack direction="row" spacing={1}>
            {step > 0 && <Button disabled={saving} onClick={() => setStep((current) => current - 1)}>{t('personas.create.back')}</Button>}
            {step < steps.length - 1 ? (
              <Button variant="contained" disabled={!stepValid || saving} onClick={() => setStep((current) => current + 1)}>
                {(step === 3 || step === 4 || step === 5) && (
                  (step === 3 && behaviorFlowRefs.length === 0)
                  || (step === 4 && appRefs.length === 0)
                  || (step === 5 && initialMemories.length === 0)
                ) ? t('personas.create.skip') : t('personas.create.next')}
              </Button>
            ) : (
              <Button variant="contained" disabled={!stepValid || saving} onClick={() => void submit()}>
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
          <Button color="error" onClick={() => { setConfirmCancel(false); reset(); onClose(); }}>{t('personas.create.discard')}</Button>
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
