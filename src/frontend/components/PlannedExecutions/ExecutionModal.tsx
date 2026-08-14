"use client";

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import ScheduleIcon from '@mui/icons-material/Schedule';
import WebhookIcon from '@mui/icons-material/Webhook';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import LanguageIcon from '@mui/icons-material/Language';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import PersonRoundedIcon from '@mui/icons-material/PersonRounded';
import { Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
import type { Persona, PersonaComposition } from '@/shared/types/enduringAgent';
import {
  FileWatchTriggerConfig,
  FlowEventTriggerConfig,
  McpPollTriggerConfig,
  OverlapStrategy,
  PlannedExecution,
  ScheduleTriggerConfig,
  TriggerConfig,
  UrlWatchTriggerConfig,
  WebhookTriggerConfig,
} from '@/shared/types/plannedExecution';
import {
  plannedExecutionsService,
  PlannedExecutionInput,
  PlannedExecutionPatch,
} from '@/frontend/services/plannedExecutions';
import { personasService } from '@/frontend/services/personas';
import { createLogger } from '@/utils/logger';
import OptionCard from './OptionCard';
import SchedulePanel from './SchedulePanel';
import WebhookPanel from './WebhookPanel';
import FileWatchPanel from './FileWatchPanel';
import WatchToolPanel from './WatchToolPanel';
import UrlWatchPanel from './UrlWatchPanel';
import FlowEventPanel from './FlowEventPanel';
import FlowSelector from '@/frontend/components/Chat/FlowSelector';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/PlannedExecutions/ExecutionModal');

const DEFAULT_SCHEDULE: ScheduleTriggerConfig = { type: 'schedule', cron: '0 9 * * *' };
const newWebhookTrigger = (): WebhookTriggerConfig => ({
  type: 'webhook',
  // Generated client-side so the URL + token are visible BEFORE the first
  // save; the backend keeps a provided token as-is.
  token: crypto.randomUUID(),
});
const DEFAULT_FILE_WATCH: FileWatchTriggerConfig = {
  type: 'file-watch',
  path: '',
  events: ['add', 'change'],
};
const DEFAULT_MCP_POLL: McpPollTriggerConfig = {
  type: 'mcp-poll',
  serverName: '',
  toolName: '',
  args: {},
  cron: '*/5 * * * *',
  evaluate: { mode: 'on-change' },
};
const DEFAULT_URL_WATCH: UrlWatchTriggerConfig = {
  type: 'url-watch',
  url: '',
  cron: '*/15 * * * *',
};
const DEFAULT_FLOW_EVENT: FlowEventTriggerConfig = {
  type: 'flow-event',
  source: { flowId: '' },
  on: ['completed'],
};

type ExecutionTargetKind = 'flow' | 'persona';

interface ExecutionModalProps {
  open: boolean;
  /** null = create a new execution. */
  execution: PlannedExecution | null;
  onClose: () => void;
  /** Called after a successful create/update so the list can refresh. */
  onSaved: () => void;
}

/**
 * Create/edit modal for a planned execution: name → target → trigger → assignment.
 * Trigger types beyond Schedule land in follow-up slices and extend the
 * radio-card row below.
 */
const ExecutionModal = ({ open, execution, onClose, onSaved }: ExecutionModalProps) => {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [targetKind, setTargetKind] = useState<ExecutionTargetKind>('flow');
  const [flowId, setFlowId] = useState('');
  const [personaId, setPersonaId] = useState('');
  const [behaviorSlotKey, setBehaviorSlotKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saveConversations, setSaveConversations] = useState(false);
  const [overlapStrategy, setOverlapStrategy] = useState<OverlapStrategy>('skip');
  const [exclusive, setExclusive] = useState(false);
  const [nonExclusiveBehavior, setNonExclusiveBehavior] =
    useState<'queue' | 'skip' | 'error'>('queue');
  const [trigger, setTrigger] = useState<TriggerConfig>(DEFAULT_SCHEDULE);
  // Pre-generated id for NEW executions, so trigger types whose config is
  // id-derived (the webhook URL) can be shown before the first save.
  const [draftId, setDraftId] = useState('');
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loadingFlows, setLoadingFlows] = useState(false);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loadingPersonas, setLoadingPersonas] = useState(false);
  const [personasError, setPersonasError] = useState(false);
  const [personaComposition, setPersonaComposition] = useState<PersonaComposition | null>(null);
  const [loadingPersonaComposition, setLoadingPersonaComposition] = useState(false);
  const [personaCompositionError, setPersonaCompositionError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset the form from the execution being edited (or to defaults) on open.
  useEffect(() => {
    if (!open) return;
    setSaveError(null);
    setName(execution?.name ?? '');
    setTargetKind(execution?.personaId ? 'persona' : 'flow');
    setFlowId(execution?.flowId ?? '');
    setPersonaId(execution?.personaId ?? '');
    setBehaviorSlotKey(execution?.behaviorSlotKey ?? '');
    setPrompt(execution?.prompt ?? '');
    setSaveConversations(execution?.saveConversations === true);
    setOverlapStrategy(execution?.overlapStrategy ?? 'skip');
    setExclusive(execution?.exclusive === true);
    setNonExclusiveBehavior(execution?.nonExclusiveBehavior ?? 'queue');
    setTrigger(execution?.trigger ?? DEFAULT_SCHEDULE);
    setDraftId(execution ? '' : crypto.randomUUID());
    setPersonaComposition(null);
    setPersonaCompositionError(false);
  }, [open, execution]);

  // Load the available flows to choose from when the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingFlows(true);
    flowService.loadFlows()
      .then((loaded) => {
        if (!cancelled) setFlows(loaded || []);
      })
      .catch((err) => {
        log.warn('Failed to load flows for execution picker', err);
        if (!cancelled) setFlows([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingFlows(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  // Personas are a first-class, plain-language Automation target alongside
  // Flows. Their internal revision ids never enter the editor.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingPersonas(true);
    setPersonasError(false);
    personasService.list()
      .then((loaded) => {
        if (!cancelled) setPersonas(loaded || []);
      })
      .catch((err) => {
        log.warn('Failed to load Personas for execution picker', err);
        if (!cancelled) {
          setPersonas([]);
          setPersonasError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPersonas(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open || targetKind !== 'persona' || !personaId) {
      setPersonaComposition(null);
      setPersonaCompositionError(false);
      setLoadingPersonaComposition(false);
      return;
    }
    let cancelled = false;
    setPersonaComposition(null);
    setPersonaCompositionError(false);
    setLoadingPersonaComposition(true);
    personasService.getComposition(personaId)
      .then((loaded) => {
        if (!cancelled) setPersonaComposition(loaded);
      })
      .catch((err) => {
        log.warn('Failed to load Persona skills for execution picker', err);
        if (!cancelled) setPersonaCompositionError(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingPersonaComposition(false);
      });
    return () => { cancelled = true; };
  }, [open, targetKind, personaId]);

  // flowId remains required persisted provenance, but Persona users choose a
  // person and a friendly skill. The matching Flow reference is derived here.
  useEffect(() => {
    if (targetKind !== 'persona' || !personaComposition) return;
    const effectiveFlowRef = behaviorSlotKey
      ? personaComposition.behaviorCards.find((card) => card.slotKey === behaviorSlotKey)
          ?.effectiveFlowRef
      : personaComposition.core?.effectiveFlowRef ?? personaComposition.coreFlowRef;
    setFlowId(effectiveFlowRef ?? '');
  }, [targetKind, personaComposition, behaviorSlotKey]);

  const selectedMissing = targetKind === 'flow'
    && !!flowId
    && !loadingFlows
    && flows.length > 0
    && !flows.some((f) => f.id === flowId);
  const selectedPersona = personas.find((persona) => persona.id === personaId);
  const selectedPersonaMissing = targetKind === 'persona'
    && !!personaId
    && !loadingPersonas
    && !personasError
    && !selectedPersona;
  const selectedBehavior = behaviorSlotKey
    ? personaComposition?.behaviorCards.find((card) => card.slotKey === behaviorSlotKey)
    : undefined;
  const selectedPersonaUnavailable = selectedPersona
    ? selectedPersona.provisioningState !== 'ready' || selectedPersona.lifecycleState === 'disabled'
    : false;
  const selectedPersonaWorkReady = targetKind !== 'persona' || Boolean(
    personaId
    && personaComposition
    && flowId
    && (behaviorSlotKey
      ? selectedBehavior?.readiness.state === 'ready'
      : personaComposition.core?.readiness.state === 'ready')
  );

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const input: PlannedExecutionInput = {
      name,
      flowId,
      prompt,
      saveConversations,
      overlapStrategy,
      exclusive,
      nonExclusiveBehavior,
      trigger,
      enabled: execution?.enabled ?? true,
      ...(targetKind === 'persona'
        ? {
            personaId,
            ...(behaviorSlotKey ? { behaviorSlotKey } : {}),
          }
        : {}),
      // The pre-generated id makes the webhook URL shown in the panel real.
      ...(execution ? {} : { id: draftId }),
    };
    const result = execution
      ? await plannedExecutionsService.update(execution.id, {
          ...input,
          personaId: targetKind === 'persona' ? personaId : null,
          behaviorSlotKey:
            targetKind === 'persona' && behaviorSlotKey ? behaviorSlotKey : null,
        } satisfies PlannedExecutionPatch)
      : await plannedExecutionsService.create(input);
    setSaving(false);
    if (!result.success) {
      setSaveError(result.error || t('automations.modal.saveFailed'));
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          borderTop: 5,
          borderColor: 'primary.main',
          maxWidth: '95vw',
          maxHeight: '90vh',
        },
      }}
    >
      <DialogHeaderActions
        title={execution ? t('automations.modal.editTitle') : t('automations.modal.newTitle')}
        onClose={onClose}
      />

      <Divider />

      <DialogContent sx={{ p: 3 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('automations.modal.intro')}
        </Typography>

        <TextField
          fullWidth
          label={t('automations.modal.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          margin="normal"
          placeholder={t('automations.modal.namePlaceholder')}
        />

        <Typography variant="subtitle1" sx={{ mt: 3, mb: 1, fontWeight: 600 }}>
          {t('automations.modal.when')}
        </Typography>
        <Box role="radiogroup" aria-label={t('automations.modal.triggerTypeAria')} sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <OptionCard
            selected={trigger.type === 'schedule'}
            onClick={() => {
              if (trigger.type !== 'schedule') {
                setTrigger(
                  execution?.trigger.type === 'schedule' ? execution.trigger : DEFAULT_SCHEDULE
                );
              }
            }}
            icon={<ScheduleIcon />}
            title={t('automations.modal.scheduleTitle')}
            description={t('automations.modal.scheduleDescription')}
          />
          <OptionCard
            selected={trigger.type === 'webhook'}
            onClick={() => {
              if (trigger.type !== 'webhook') {
                setTrigger(
                  execution?.trigger.type === 'webhook' ? execution.trigger : newWebhookTrigger()
                );
              }
            }}
            icon={<WebhookIcon />}
            title={t('automations.modal.webhookTitle')}
            description={t('automations.modal.webhookDescription')}
          />
          <OptionCard
            selected={trigger.type === 'file-watch'}
            onClick={() => {
              if (trigger.type !== 'file-watch') {
                setTrigger(
                  execution?.trigger.type === 'file-watch' ? execution.trigger : DEFAULT_FILE_WATCH
                );
              }
            }}
            icon={<FolderOpenIcon />}
            title={t('automations.modal.fileTitle')}
            description={t('automations.modal.fileDescription')}
          />
          <OptionCard
            selected={trigger.type === 'mcp-poll'}
            onClick={() => {
              if (trigger.type !== 'mcp-poll') {
                setTrigger(
                  execution?.trigger.type === 'mcp-poll' ? execution.trigger : DEFAULT_MCP_POLL
                );
              }
            }}
            icon={<TravelExploreIcon />}
            title={t('automations.modal.toolTitle')}
            description={t('automations.modal.toolDescription')}
          />
          <OptionCard
            selected={trigger.type === 'url-watch'}
            onClick={() => {
              if (trigger.type !== 'url-watch') {
                setTrigger(
                  execution?.trigger.type === 'url-watch' ? execution.trigger : DEFAULT_URL_WATCH
                );
              }
            }}
            icon={<LanguageIcon />}
            title={t('automations.modal.urlTitle')}
            description={t('automations.modal.urlDescription')}
          />
          <OptionCard
            selected={trigger.type === 'flow-event'}
            onClick={() => {
              if (trigger.type !== 'flow-event') {
                setTrigger(
                  execution?.trigger.type === 'flow-event' ? execution.trigger : DEFAULT_FLOW_EVENT
                );
              }
            }}
            icon={<AltRouteIcon />}
            title={t('automations.modal.flowEventTitle')}
            description={t('automations.modal.flowEventDescription')}
          />
        </Box>

        {trigger.type === 'schedule' && (
          <SchedulePanel
            cron={trigger.cron}
            timezone={trigger.timezone}
            onChange={({ cron, timezone }) => setTrigger({ ...trigger, cron, timezone })}
            catchUp={trigger.catchUp === true}
            onCatchUpChange={(catchUp) => setTrigger({ ...trigger, catchUp })}
          />
        )}
        {trigger.type === 'webhook' && (
          <WebhookPanel
            config={trigger}
            onChange={setTrigger}
            executionId={execution?.id ?? draftId}
            saved={execution !== null}
          />
        )}
        {trigger.type === 'file-watch' && (
          <FileWatchPanel config={trigger} onChange={setTrigger} />
        )}
        {trigger.type === 'mcp-poll' && (
          <WatchToolPanel config={trigger} onChange={setTrigger} />
        )}
        {trigger.type === 'url-watch' && (
          <UrlWatchPanel config={trigger} onChange={setTrigger} />
        )}
        {trigger.type === 'flow-event' && (
          <FlowEventPanel
            config={trigger}
            onChange={setTrigger}
            flows={flows}
            currentExecutionId={execution?.id ?? draftId}
          />
        )}

        <FormControl fullWidth margin="normal">
          <InputLabel id="overlap-strategy-label">{t('automations.modal.alreadyRunning')}</InputLabel>
          <Select
            labelId="overlap-strategy-label"
            label={t('automations.modal.alreadyRunning')}
            value={overlapStrategy}
            onChange={(e) => setOverlapStrategy(e.target.value as OverlapStrategy)}
          >
            <MenuItem value="skip">{t('automations.modal.overlapSkip')}</MenuItem>
            <MenuItem value="queue">{t('automations.modal.overlapQueue')}</MenuItem>
            <MenuItem value="parallel">{t('automations.modal.overlapParallel')}</MenuItem>
            <MenuItem value="error">{t('automations.modal.overlapError')}</MenuItem>
          </Select>
          <FormHelperText>
            {overlapStrategy === 'parallel' &&
            (trigger.type === 'url-watch' || trigger.type === 'mcp-poll')
              ? t('automations.modal.parallelWarning')
              : overlapStrategy === 'queue'
                ? t('automations.modal.queueHelp')
                : t('automations.modal.overlapHelp')}
          </FormHelperText>
        </FormControl>

        <FormControlLabel
          sx={{ mt: 1 }}
          control={
            <Switch
              checked={exclusive}
              onChange={(e) => setExclusive(e.target.checked)}
            />
          }
          label={t('automations.modal.exclusive')}
        />
        {exclusive && (
          <FormControl fullWidth margin="normal">
            <InputLabel id="non-exclusive-behavior-label">
              {t('automations.modal.otherTriggers')}
            </InputLabel>
            <Select
              labelId="non-exclusive-behavior-label"
              label={t('automations.modal.otherTriggers')}
              value={nonExclusiveBehavior}
              onChange={(e) =>
                setNonExclusiveBehavior(e.target.value as 'queue' | 'skip' | 'error')
              }
            >
              <MenuItem value="queue">{t('automations.modal.othersQueue')}</MenuItem>
              <MenuItem value="skip">{t('automations.modal.othersSkip')}</MenuItem>
              <MenuItem value="error">{t('automations.modal.othersError')}</MenuItem>
            </Select>
            <FormHelperText>
              {t('automations.modal.exclusiveHelp')}
            </FormHelperText>
          </FormControl>
        )}

        <Divider sx={{ mt: 3 }} />
        <Typography variant="subtitle1" sx={{ mt: 2, mb: 0, fontWeight: 600 }}>
          {t('automations.modal.what')}
        </Typography>

        <Box
          role="radiogroup"
          aria-label={t('automations.modal.targetTypeAria')}
          sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 2 }}
        >
          <OptionCard
            selected={targetKind === 'persona'}
            onClick={() => {
              if (targetKind !== 'persona') {
                setTargetKind('persona');
                setFlowId('');
              }
            }}
            icon={<PersonRoundedIcon />}
            title={t('automations.modal.targetPersona')}
            description={t('automations.modal.targetPersonaHelp')}
          />
          <OptionCard
            selected={targetKind === 'flow'}
            onClick={() => {
              if (targetKind !== 'flow') {
                setTargetKind('flow');
                setFlowId('');
              }
            }}
            icon={<AccountTreeRoundedIcon />}
            title={t('automations.modal.targetFlow')}
            description={t('automations.modal.targetFlowHelp')}
          />
        </Box>

        {targetKind === 'flow' ? (
          <>
            <Box sx={{ mt: 2 }}>
              <FlowSelector
                selectedFlowId={flowId || null}
                onSelectFlow={setFlowId}
                disabled={saving}
                hideLabel
              />
            </Box>

            {selectedMissing && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {t('automations.modal.flowMissing')}
              </Alert>
            )}
          </>
        ) : (
          <Box sx={{ mt: 1 }}>
            <FormControl fullWidth margin="normal" required>
              <InputLabel id="automation-persona-label">
                {t('automations.modal.persona')}
              </InputLabel>
              <Select
                labelId="automation-persona-label"
                label={t('automations.modal.persona')}
                value={personaId}
                disabled={saving || loadingPersonas}
                onChange={(event) => {
                  setPersonaId(event.target.value);
                  setBehaviorSlotKey('');
                  setFlowId('');
                }}
              >
                <MenuItem value="" disabled>
                  {t('automations.modal.choosePersona')}
                </MenuItem>
                {personaId && !personas.some((persona) => persona.id === personaId) && (
                  <MenuItem value={personaId} disabled>
                    {loadingPersonas
                      ? t('automations.modal.loadingPersonas')
                      : t('automations.modal.personaUnavailable')}
                  </MenuItem>
                )}
                {personas.map((persona) => {
                  const unavailable = persona.provisioningState !== 'ready'
                    || persona.lifecycleState === 'disabled';
                  return (
                    <MenuItem key={persona.id} value={persona.id} disabled={unavailable}>
                      {persona.name}{unavailable ? ` — ${t('automations.modal.personaUnavailable')}` : ''}
                    </MenuItem>
                  );
                })}
              </Select>
              <FormHelperText>
                {loadingPersonas
                  ? t('automations.modal.loadingPersonas')
                  : t('automations.modal.personaHelp')}
              </FormHelperText>
            </FormControl>

            {personasError && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {t('automations.modal.personasLoadFailed')}
              </Alert>
            )}
            {!loadingPersonas && !personasError && personas.length === 0 && (
              <Alert severity="info" sx={{ mt: 1 }}>
                {t('automations.modal.noPersonas')}
              </Alert>
            )}
            {selectedPersonaMissing && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {t('automations.modal.personaMissing')}
              </Alert>
            )}
            {selectedPersonaUnavailable && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {t('automations.modal.personaNotReady')}
              </Alert>
            )}

            {loadingPersonaComposition && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  {t('automations.modal.loadingPersonaSkills')}
                </Typography>
              </Box>
            )}
            {personaCompositionError && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {t('automations.modal.personaSkillsLoadFailed')}
              </Alert>
            )}
            {personaComposition && (
              <FormControl fullWidth margin="normal">
                <InputLabel id="automation-persona-skill-label">
                  {t('automations.modal.personaSkill')}
                </InputLabel>
                <Select
                  labelId="automation-persona-skill-label"
                  label={t('automations.modal.personaSkill')}
                  value={behaviorSlotKey}
                  disabled={saving}
                  onChange={(event) => setBehaviorSlotKey(event.target.value)}
                >
                  <MenuItem
                    value=""
                    disabled={personaComposition.core?.readiness.state !== 'ready'}
                  >
                    {t('automations.modal.personaMainRole')}
                  </MenuItem>
                  {personaComposition.behaviorCards.map((behavior) => (
                    <MenuItem
                      key={behavior.ref}
                      value={behavior.slotKey}
                      disabled={behavior.readiness.state !== 'ready'}
                    >
                      {behavior.name}
                    </MenuItem>
                  ))}
                  {behaviorSlotKey
                    && !personaComposition.behaviorCards.some(
                      (behavior) => behavior.slotKey === behaviorSlotKey,
                    ) && (
                      <MenuItem value={behaviorSlotKey} disabled>
                        {t('automations.modal.personaUnavailable')}
                      </MenuItem>
                    )}
                </Select>
                <FormHelperText>
                  {selectedBehavior?.description || t('automations.modal.personaSkillHelp')}
                </FormHelperText>
              </FormControl>
            )}

            {personaComposition && !selectedPersonaWorkReady && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                {t('automations.modal.personaWorkMissing')}
              </Alert>
            )}
          </Box>
        )}

        <TextField
          fullWidth
          label={t(targetKind === 'persona'
            ? 'automations.modal.personaPrompt'
            : 'automations.modal.prompt')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          margin="normal"
          multiline
          rows={3}
          helperText={t(targetKind === 'persona'
            ? 'automations.modal.personaPromptHelp'
            : 'automations.modal.promptHelp')}
        />

        <FormControlLabel
          sx={{ mt: 1 }}
          control={
            <Switch
              checked={saveConversations}
              onChange={(e) => setSaveConversations(e.target.checked)}
            />
          }
          label={t('automations.modal.saveConversations')}
        />

        {saveError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {saveError}
          </Alert>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          onClick={handleSave}
          variant="contained"
          color="primary"
          disabled={
            saving
            || !name.trim()
            || !flowId
            || (targetKind === 'persona' && (
              loadingPersonaComposition
              || selectedPersonaUnavailable
              || !selectedPersonaWorkReady
            ))
          }
        >
          {saving ? t('automations.modal.saving') : t('automations.modal.saveTrigger')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ExecutionModal;
