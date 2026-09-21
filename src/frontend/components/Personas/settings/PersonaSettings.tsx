"use client";

import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useI18n } from '@/frontend/contexts/I18nContext';
import {
  PersonasApiError,
  type PersonaDetail,
} from '@/frontend/services/personas';
import { personaSettingsService } from '@/frontend/services/personas/settings';
import {
  PERSONA_AUTONOMY_LEVELS,
  PERSONA_INTERRUPTION_POLICIES,
  type Persona,
  type PersonaDeletionArchivePolicy,
  type PersonaDeletionPreview,
  type PersonaExportPreview,
  type PersonaSettingsOptions,
} from '@/shared/types/enduringAgent';

interface PersonaSettingsProps {
  detail: PersonaDetail;
  onRefresh: () => Promise<void>;
  onDeleted: () => void;
}

const settingsChoiceMenuProps = {
  slotProps: {
    paper: {
      sx: {
        maxWidth: 'calc(100vw - 32px)',
        '& .MuiMenuItem-root': { whiteSpace: 'normal', overflowWrap: 'anywhere' },
      },
    },
  },
};

interface SettingsDraft {
  name: string;
  roleVersionId: string;
  mission: string;
  avatarUrl: string;
  language: string;
  lifecycleState: 'idle' | 'sleeping' | 'disabled';
  autonomyLevel: Persona['autonomyLevel'];
  interruptionPolicy: Persona['interruptionPolicy'];
}

function draftFromPersona(persona: Persona): SettingsDraft {
  return {
    name: persona.name,
    roleVersionId: persona.roleVersionId,
    mission: persona.mission ?? '',
    avatarUrl: persona.presentation?.avatarUrl ?? '',
    language: persona.presentation?.language ?? '',
    lifecycleState: persona.lifecycleState === 'sleeping'
      || persona.lifecycleState === 'disabled'
      ? persona.lifecycleState
      : 'idle',
    autonomyLevel: persona.autonomyLevel,
    interruptionPolicy: persona.interruptionPolicy,
  };
}

function normalized(draft: SettingsDraft): string {
  return JSON.stringify({
    ...draft,
    name: draft.name.trim(),
    mission: draft.mission.trim(),
    avatarUrl: draft.avatarUrl.trim(),
    language: draft.language.trim(),
  });
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" component="h3">{title}</Typography>
            {description && (
              <Typography variant="body2" color="text.secondary">
                {description}
              </Typography>
            )}
          </Box>
          {children}
        </Stack>
      </CardContent>
    </Card>
  );
}

export default function PersonaSettings({
  detail,
  onRefresh,
  onDeleted,
}: PersonaSettingsProps) {
  const { t } = useI18n();
  const initial = useMemo(
    () => draftFromPersona(detail.persona),
    [detail.persona],
  );
  const [baseline, setBaseline] = useState(initial);
  const [form, setForm] = useState(initial);
  const [options, setOptions] = useState<PersonaSettingsOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPreview, setExportPreview] = useState<PersonaExportPreview | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePreview, setDeletePreview] = useState<PersonaDeletionPreview | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [archivePolicy, setArchivePolicy] =
    useState<PersonaDeletionArchivePolicy>('anonymize');
  const personaIdRef = useRef(detail.persona.id);
  const latestServerUpdatedAtRef = useRef(detail.persona.updatedAt);
  const [pendingNavigation, setPendingNavigation] = useState<HTMLElement | null>(null);
  const navigationTrigger = useRef<HTMLElement | null>(null);

  const dirty = normalized(form) !== normalized(baseline);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const valid = form.name.trim().length > 0 && form.name.trim().length <= 160;

  useEffect(() => {
    if (personaIdRef.current !== detail.persona.id) {
      personaIdRef.current = detail.persona.id;
      latestServerUpdatedAtRef.current = detail.persona.updatedAt;
      const next = draftFromPersona(detail.persona);
      setBaseline(next);
      setForm(next);
      setConflict(false);
      setSaveError(null);
      setSaveNotice(null);
      return;
    }
    if (detail.persona.updatedAt === latestServerUpdatedAtRef.current) return;
    latestServerUpdatedAtRef.current = detail.persona.updatedAt;
    const next = draftFromPersona(detail.persona);
    if (dirty) {
      setBaseline(next);
      setConflict(true);
      setSaveError(t('personas.settings.conflict'));
      return;
    }
    setBaseline(next);
    setForm(next);
  }, [detail.persona, dirty, t]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const warnForLink = (event: MouseEvent) => {
      if (!dirtyRef.current || event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      const navigation = target instanceof Element
        ? target.closest<HTMLElement>('a[href], [data-persona-navigation] [role="tab"]')
        : null;
      if (!navigation || navigation.getAttribute('aria-selected') === 'true') return;
      if (navigation instanceof HTMLAnchorElement && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || navigation.hasAttribute('download') || (navigation.target && navigation.target !== '_self'))) return;
      event.preventDefault();
      event.stopPropagation();
      navigationTrigger.current = navigation;
      setPendingNavigation(navigation);
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', warnForLink, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', warnForLink, true);
    };
  }, []);

  const loadOptions = async () => {
    setOptionsLoading(true);
    setOptionsError(null);
    try {
      setOptions(await personaSettingsService.options());
    } catch (cause) {
      setOptionsError(cause instanceof Error
        ? cause.message
        : t('personas.settings.optionsFailed'));
    } finally {
      setOptionsLoading(false);
    }
  };

  useEffect(() => { void loadOptions(); }, []);

  const set = <K extends keyof SettingsDraft>(
    key: K,
    value: SettingsDraft[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    if (!dirty || !valid) return;
    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);
    setConflict(false);
    try {
      const saved = await personaSettingsService.update(detail.persona.id, {
        name: form.name.trim(),
        roleVersionId: form.roleVersionId,
        mission: form.mission.trim() || null,
        presentation: {
          avatarUrl: form.avatarUrl.trim() || null,
          language: form.language.trim() || null,
        },
        lifecycleState: form.lifecycleState,
        autonomyLevel: form.autonomyLevel,
        interruptionPolicy: form.interruptionPolicy,
        expectedUpdatedAt: latestServerUpdatedAtRef.current,
      });
      latestServerUpdatedAtRef.current = saved.updatedAt;
      const next = draftFromPersona(saved);
      setBaseline(next);
      setForm(next);
      setSaveNotice(t('personas.settings.saved'));
      await onRefresh();
    } catch (cause) {
      if (cause instanceof PersonasApiError && cause.status === 409) {
        setConflict(true);
        setSaveError(t('personas.settings.conflict'));
      } else {
        setSaveError(cause instanceof Error
          ? cause.message
          : t('personas.settings.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadServerValues = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const fresh = await personaSettingsService.get(detail.persona.id);
      latestServerUpdatedAtRef.current = fresh.persona.updatedAt;
      const next = draftFromPersona(fresh.persona);
      setBaseline(next);
      setForm(next);
      setConflict(false);
      await onRefresh();
    } catch (cause) {
      setSaveError(cause instanceof Error
        ? cause.message
        : t('personas.settings.reloadFailed'));
    } finally {
      setSaving(false);
    }
  };

  const openExport = async () => {
    setExportOpen(true);
    setExportBusy(true);
    setExportError(null);
    setExportPreview(null);
    try {
      setExportPreview(await personaSettingsService.exportPreview(
        detail.persona.id,
        { scope: 'configuration_only' },
      ));
    } catch (cause) {
      setExportError(cause instanceof Error
        ? cause.message
        : t('personas.settings.exportFailed'));
    } finally {
      setExportBusy(false);
    }
  };

  const downloadExport = async () => {
    setExportBusy(true);
    setExportError(null);
    try {
      const artifact = await personaSettingsService.exportConfiguration(
        detail.persona.id,
        { scope: 'configuration_only' },
      );
      const href = URL.createObjectURL(artifact.blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = artifact.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
      setExportOpen(false);
    } catch (cause) {
      setExportError(cause instanceof Error
        ? cause.message
        : t('personas.settings.exportFailed'));
    } finally {
      setExportBusy(false);
    }
  };

  const refreshDeletionPreview = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      setDeletePreview(
        await personaSettingsService.deletionPreview(detail.persona.id),
      );
    } catch (cause) {
      setDeleteError(cause instanceof Error
        ? cause.message
        : t('personas.settings.deletePreviewFailed'));
    } finally {
      setDeleteBusy(false);
    }
  };

  const openDelete = () => {
    setDeleteOpen(true);
    setConfirmation('');
    setArchivePolicy('anonymize');
    setDeletePreview(null);
    void refreshDeletionPreview();
  };

  const deletePersona = async () => {
    if (!deletePreview || confirmation !== 'DELETE') return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await personaSettingsService.delete(detail.persona.id, {
        previewToken: deletePreview.previewToken,
        archivePolicy,
        confirmation: 'DELETE',
      });
      setDeleteOpen(false);
      onDeleted();
    } catch (cause) {
      if (cause instanceof PersonasApiError && cause.status === 409) {
        setDeleteError(t('personas.settings.deleteConflict'));
        await refreshDeletionPreview();
      } else {
        setDeleteError(cause instanceof Error
          ? cause.message
          : t('personas.settings.deleteFailed'));
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  const legacyLanguage = form.language
    && !options?.languages.some((language) => language.code === form.language);
  const selectedRole = options?.roles.find(
    (role) => role.roleVersionId === form.roleVersionId,
  );
  const selectedRoleUnavailable = Boolean(options && !selectedRole);

  return (
    <Stack spacing={2} maxWidth={900} sx={{
      '&& .MuiSelect-select': { whiteSpace: 'normal', overflowWrap: 'anywhere', height: 'auto' },
    }}>
      <Box>
        <Typography variant="h5" component="h2">
          {t('personas.settings.title')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('personas.settings.description')}
        </Typography>
      </Box>

      {optionsError && (
        <Alert
          severity="warning"
          action={<Button onClick={() => void loadOptions()}>{t('personas.retry')}</Button>}
        >
          {optionsError}
        </Alert>
      )}

      <SectionCard
        title={t('personas.settings.about')}
        description={t('personas.settings.aboutHelp')}
      >
        <TextField
          label={t('personas.settings.name')}
          value={form.name}
          onChange={(event) => set('name', event.target.value)}
          required
          inputProps={{ maxLength: 160 }}
          error={!valid}
        />
        <TextField
          label={t('personas.settings.mission')}
          value={form.mission}
          onChange={(event) => set('mission', event.target.value)}
          multiline
          minRows={3}
          inputProps={{ maxLength: 20_000 }}
        />
        <TextField
          label={t('personas.settings.picture')}
          value={form.avatarUrl}
          onChange={(event) => set('avatarUrl', event.target.value)}
          helperText={t('personas.settings.pictureHelp')}
          inputProps={{ maxLength: 2_000 }}
        />
        {form.avatarUrl && (
          <Stack direction="row" spacing={2} alignItems="center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={form.avatarUrl}
              alt=""
              width={64}
              height={64}
              style={{ borderRadius: '50%', objectFit: 'cover' }}
            />
            <Typography variant="body2" color="text.secondary">
              {t('personas.settings.picturePreview')}
            </Typography>
            <Button onClick={() => set('avatarUrl', '')}>
              {t('personas.settings.removePicture')}
            </Button>
          </Stack>
        )}
      </SectionCard>

      <SectionCard
        title={t('personas.settings.role')}
        description={t('personas.settings.roleHelp')}
      >
        {options ? (
          <FormControl fullWidth>
            <InputLabel id="persona-role-label">
              {t('personas.settings.role')}
            </InputLabel>
            <Select
              labelId="persona-role-label"
              MenuProps={settingsChoiceMenuProps}
              label={t('personas.settings.role')}
              value={form.roleVersionId}
              onChange={(event) => set('roleVersionId', event.target.value)}
            >
              {selectedRoleUnavailable && (
                <MenuItem value={form.roleVersionId}>
                  {t('personas.settings.roleUnavailableChoice', {
                    role: detail.roleVersion.name,
                  })}
                </MenuItem>
              )}
              {options.roles.map((role) => (
                <MenuItem key={role.roleVersionId} value={role.roleVersionId}>
                  {role.name}
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>{t('personas.settings.roleFutureHelp')}</FormHelperText>
          </FormControl>
        ) : optionsLoading ? (
          <CircularProgress size={24} aria-label={t('personas.settings.loadingOptions')} />
        ) : (
          <Alert severity="info">{t('personas.settings.roleOptionsUnavailable')}</Alert>
        )}
        {selectedRole?.description && (
          <Typography variant="body2" color="text.secondary">
            {selectedRole.description}
          </Typography>
        )}
        {selectedRoleUnavailable && (
          <Alert severity="info">
            {t('personas.settings.roleUnavailable', { role: detail.roleVersion.name })}
          </Alert>
        )}
      </SectionCard>

      <SectionCard
        title={t('personas.settings.language')}
        description={t('personas.settings.languageHelp')}
      >
        {options ? (
          <FormControl fullWidth>
            <InputLabel id="persona-language-label" shrink>
              {t('personas.settings.language')}
            </InputLabel>
            <Select
              labelId="persona-language-label"
              MenuProps={settingsChoiceMenuProps}
              label={t('personas.settings.language')}
              displayEmpty
              notched
              value={form.language}
              onChange={(event) => set('language', event.target.value)}
            >
              <MenuItem value="">{t('personas.settings.useDefault')}</MenuItem>
              {legacyLanguage && (
                <MenuItem value={form.language}>
                  {t('personas.settings.legacyChoice', { value: form.language })}
                </MenuItem>
              )}
              {options.languages.map((language) => (
                <MenuItem key={language.code} value={language.code}>
                  {language.label}
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>{t('personas.settings.languageHelp')}</FormHelperText>
          </FormControl>
        ) : optionsLoading ? (
          <CircularProgress size={24} aria-label={t('personas.settings.loadingOptions')} />
        ) : (
          <Alert severity="info">{t('personas.settings.languageUnavailable')}</Alert>
        )}
      </SectionCard>

      <SectionCard
        title={t('personas.settings.data')}
        description={t('personas.settings.dataHelp')}
      >
        <Alert severity="success">{t('personas.settings.privateDefault')}</Alert>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="outlined" onClick={() => void openExport()}>
            {t('personas.settings.export')}
          </Button>
          <Button color="error" variant="outlined" onClick={openDelete}>
            {t('personas.settings.delete')}
          </Button>
        </Stack>
      </SectionCard>

      <SectionCard
        title={t('personas.settings.advanced')}
        description={t('personas.settings.advancedHelp')}
      >
        <FormControl fullWidth>
          <InputLabel id="persona-lifecycle-label">
            {t('personas.settings.lifecycle')}
          </InputLabel>
          <Select
            labelId="persona-lifecycle-label"
            MenuProps={settingsChoiceMenuProps}
            label={t('personas.settings.lifecycle')}
            value={form.lifecycleState}
            onChange={(event) => set(
              'lifecycleState',
              event.target.value as SettingsDraft['lifecycleState'],
            )}
          >
            {(options?.lifecycleStates ?? ['idle', 'sleeping', 'disabled']).map((value) => (
              <MenuItem key={value} value={value}>
                {t(`personas.settings.lifecycle.${value}`)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel id="persona-autonomy-label">
            {t('personas.settings.autonomy')}
          </InputLabel>
          <Select
            labelId="persona-autonomy-label"
            MenuProps={settingsChoiceMenuProps}
            label={t('personas.settings.autonomy')}
            value={form.autonomyLevel}
            onChange={(event) => set(
              'autonomyLevel',
              event.target.value as SettingsDraft['autonomyLevel'],
            )}
          >
            {(options?.autonomyLevels ?? PERSONA_AUTONOMY_LEVELS).map((value) => (
              <MenuItem key={value} value={value}>
                {t(`personas.settings.autonomy.${value}`)}
              </MenuItem>
            ))}
          </Select>
          <FormHelperText>{t('personas.settings.autonomyHelp')}</FormHelperText>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel id="persona-interruption-label">
            {t('personas.settings.interruption')}
          </InputLabel>
          <Select
            labelId="persona-interruption-label"
            MenuProps={settingsChoiceMenuProps}
            label={t('personas.settings.interruption')}
            value={form.interruptionPolicy}
            onChange={(event) => set(
              'interruptionPolicy',
              event.target.value as SettingsDraft['interruptionPolicy'],
            )}
          >
            {(options?.interruptionPolicies ?? PERSONA_INTERRUPTION_POLICIES).map((value) => (
              <MenuItem key={value} value={value}>
                {t(`personas.settings.interruption.${value}`)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </SectionCard>

      <Box aria-live="polite">
        {dirty && <Alert severity="warning">{t('personas.settings.unsaved')}</Alert>}
        {saveNotice && <Alert severity="success">{saveNotice}</Alert>}
        {saveError && (
          <Alert
            severity={conflict ? 'warning' : 'error'}
            action={conflict ? (
              <Button onClick={() => void reloadServerValues()} disabled={saving}>
                {t('personas.settings.reloadServer')}
              </Button>
            ) : (
              <Button onClick={() => void save()} disabled={saving}>
                {t('personas.settings.retrySave')}
              </Button>
            )}
          >
            {saveError}
          </Alert>
        )}
      </Box>
      <Stack direction="row" justifyContent="flex-end">
        <Button
          variant="contained"
          onClick={() => void save()}
          disabled={!dirty || !valid || saving}
        >
          {saving ? t('personas.action.saving') : t('personas.settings.save')}
        </Button>
      </Stack>

      <Dialog
        open={exportOpen}
        onClose={() => !exportBusy && setExportOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('personas.settings.exportTitle')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {exportBusy && !exportPreview && (
              <Stack direction="row" spacing={1.5} alignItems="center" role="status">
                <CircularProgress size={24} aria-hidden="true" />
                <Typography>{t('personas.settings.loadingExport')}</Typography>
              </Stack>
            )}
            {exportError && <Alert severity="error">{exportError}</Alert>}
            {exportPreview && (
              <>
                <Alert severity="success">
                  {t('personas.settings.exportPrivacy')}
                </Alert>
                <Typography variant="subtitle2">
                  {t('personas.settings.exportIncluded')}
                </Typography>
                <Typography variant="body2">
                  {t('personas.settings.exportIncludedSummary', {
                    roles: exportPreview.included.roleTemplates,
                    versions: exportPreview.included.roleVersions,
                    personas: exportPreview.included.personaTemplates,
                  })}
                </Typography>
                <Divider />
                <Typography variant="subtitle2">
                  {t('personas.settings.exportExcluded')}
                </Typography>
                <Box component="ul" sx={{ my: 0, pl: 3 }}>
                  {exportPreview.excluded.map((category) => (
                    <li key={category}>
                      <Typography variant="body2">
                        {t(`personas.settings.export.category.${category}`)}
                      </Typography>
                    </li>
                  ))}
                </Box>
                <Typography variant="caption" color="text.secondary">
                  {t('personas.settings.exportDigest', {
                    digest: exportPreview.artifact.sha256,
                  })}
                </Typography>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExportOpen(false)} disabled={exportBusy}>
            {t('personas.action.cancel')}
          </Button>
          <Button
            variant="contained"
            onClick={() => void downloadExport()}
            disabled={!exportPreview || exportBusy}
          >
            {t('personas.settings.download')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(pendingNavigation)} fullWidth maxWidth="sm" aria-labelledby="persona-discard-title"
        disableRestoreFocus onClose={() => setPendingNavigation(null)}
        slotProps={{ transition: { onExited: () => {
          if (dirtyRef.current && navigationTrigger.current?.isConnected) navigationTrigger.current.focus();
        } } }}>
        <DialogTitle id="persona-discard-title">{t('personas.settings.discardPrompt')}</DialogTitle>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Button autoFocus onClick={() => setPendingNavigation(null)}>{t('personas.action.cancel')}</Button>
          <Button color="warning" variant="contained" onClick={() => {
            const navigation = pendingNavigation;
            dirtyRef.current = false;
            setForm(baseline);
            setPendingNavigation(null);
            navigation?.click();
          }}>{t('personas.settings.discardAndLeave')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => !deleteBusy && setDeleteOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('personas.settings.deleteTitle')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {deleteBusy && !deletePreview && (
              <Stack direction="row" spacing={1.5} alignItems="center" role="status">
                <CircularProgress size={24} aria-hidden="true" />
                <Typography>{t('personas.settings.loadingDeletion')}</Typography>
              </Stack>
            )}
            {deleteError && (
              <Alert
                severity="error"
                action={(
                  <Button
                    onClick={() => void refreshDeletionPreview()}
                    disabled={deleteBusy}
                  >
                    {t('personas.retry')}
                  </Button>
                )}
              >
                {deleteError}
              </Alert>
            )}
            {deletePreview && (
              <>
                {deletePreview.activeLease && (
                  <Alert severity="warning">
                    {t('personas.settings.deleteActiveLease')}
                  </Alert>
                )}
                <Typography>{t('personas.settings.deleteRemoved')}</Typography>
                <Typography variant="body2">
                  {t('personas.settings.deleteCounts', {
                    memories: deletePreview.counts.memoryItems,
                    work: deletePreview.counts.workItems,
                    activities: deletePreview.counts.liveActivities
                      + deletePreview.counts.archivedActivities,
                    calls: deletePreview.counts.behaviorCallPins ?? 0,
                    files: deletePreview.counts.homeFiles,
                  })}
                </Typography>
                <Typography variant="body2">
                  {t('personas.settings.deleteOwnedFlows', {
                    flows: deletePreview.counts.ownedFlows ?? 0,
                    files: deletePreview.counts.ownedFlowFiles ?? 0,
                  })}
                </Typography>
                <Alert severity="info">
                  {t('personas.settings.deleteRetained', {
                    apps: deletePreview.externalSharedResources.mcpConfigNames.length,
                  })}
                </Alert>
                <Alert severity="info">
                  {t('personas.settings.deleteBackups')}
                </Alert>
                <FormControl fullWidth>
                  <InputLabel id="persona-archive-policy-label">
                    {t('personas.settings.archivePolicy')}
                  </InputLabel>
                  <Select
                    labelId="persona-archive-policy-label"
                    label={t('personas.settings.archivePolicy')}
                    value={archivePolicy}
                    onChange={(event) => setArchivePolicy(
                      event.target.value as PersonaDeletionArchivePolicy,
                    )}
                  >
                    <MenuItem value="anonymize">
                      {t('personas.settings.archive.anonymize')}
                    </MenuItem>
                    <MenuItem value="retain_tombstone">
                      {t('personas.settings.archive.retainTombstone')}
                    </MenuItem>
                  </Select>
                </FormControl>
                <TextField
                  autoFocus
                  label={t('personas.settings.deleteConfirmation')}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  helperText={t('personas.settings.deleteConfirmationHelp')}
                />
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)} disabled={deleteBusy}>
            {t('personas.action.cancel')}
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void deletePersona()}
            disabled={!deletePreview || confirmation !== 'DELETE' || deleteBusy}
          >
            {t('personas.settings.delete')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
