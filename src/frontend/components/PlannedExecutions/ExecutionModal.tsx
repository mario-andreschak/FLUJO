"use client";

import React, { useEffect, useRef, useState } from 'react';
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
  Tab,
  Tabs,
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
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { Flow } from '@/frontend/types/flow/flow';
import { flowService } from '@/frontend/services/flow';
import type { Persona, PersonaComposition } from '@/shared/types/enduringAgent';
import {
  FileWatchTriggerConfig,
  FlowEventTriggerConfig,
  McpPollTriggerConfig,
  normalizeStartRestrictions,
  OverlapStrategy,
  PlannedExecution,
  ScheduleTriggerConfig,
  StartRestriction,
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
type ExecutionSection = 'when' | 'what' | 'restrictions';

const EXECUTION_SECTIONS: ExecutionSection[] = ['when', 'what', 'restrictions'];
const START_RESTRICTIONS: StartRestriction[] = ['unrestricted', 'singleton', 'exclusive'];

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
  const [startRestriction, setStartRestriction] = useState<StartRestriction>('unrestricted');
  const [superExclusive, setSuperExclusive] = useState(false);
  const [emergency, setEmergency] = useState(false);
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
  const [activeSection, setActiveSection] = useState<ExecutionSection>('when');
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const whenRef = useRef<HTMLDivElement>(null);
  const whatRef = useRef<HTMLDivElement>(null);
  const restrictionsRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const targetSelectionRef = useRef<HTMLDivElement>(null);
  const programmaticScroll = useRef(false);
  const restrictionCardRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
    const restrictions = normalizeStartRestrictions(execution ?? {});
    setStartRestriction(restrictions.startRestriction);
    setSuperExclusive(restrictions.superExclusive);
    setEmergency(restrictions.emergency);
    setNonExclusiveBehavior(execution?.nonExclusiveBehavior ?? 'queue');
    setTrigger(execution?.trigger ?? DEFAULT_SCHEDULE);
    setDraftId(execution ? '' : crypto.randomUUID());
    setPersonaComposition(null);
    setPersonaCompositionError(false);
    setActiveSection('when');
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
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

  const sectionRef = (section: ExecutionSection) => {
    if (section === 'when') return whenRef;
    if (section === 'what') return whatRef;
    return restrictionsRef;
  };

  useEffect(() => {
    if (!open || typeof IntersectionObserver === 'undefined') return;
    const root = scrollContainerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      if (programmaticScroll.current) return;
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio);
      const section = (visible[0]?.target as HTMLElement | undefined)
        ?.dataset.section as ExecutionSection | undefined;
      if (section) setActiveSection(section);
    }, {
      root,
      threshold: [0.2, 0.5, 0.8],
      rootMargin: '0px 0px -40% 0px',
    });
    [whenRef, whatRef, restrictionsRef].forEach((ref) => {
      if (ref.current) observer.observe(ref.current);
    });
    return () => observer.disconnect();
  }, [open, execution]);

  const handleSectionClick = (section: ExecutionSection) => {
    setActiveSection(section);
    programmaticScroll.current = true;
    const target = sectionRef(section).current;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    window.setTimeout(() => {
      programmaticScroll.current = false;
    }, 500);
  };

  const selectStartRestriction = (restriction: StartRestriction) => {
    setStartRestriction(restriction);
    if (restriction === 'singleton' && overlapStrategy === 'parallel') {
      setOverlapStrategy('skip');
    }
  };

  const handleRestrictionKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const nextIndex = (index + delta + START_RESTRICTIONS.length) % START_RESTRICTIONS.length;
    selectStartRestriction(START_RESTRICTIONS[nextIndex]);
    restrictionCardRefs.current[nextIndex]?.focus();
  };

  const focusFirstInvalidControl = () => {
    let section: ExecutionSection | null = null;
    let focusTarget: (() => HTMLElement | null | undefined) | null = null;

    if (!name.trim()) {
      section = 'when';
      focusTarget = () => nameInputRef.current;
    } else if (
      !flowId
      || selectedMissing
      || selectedPersonaMissing
      || selectedPersonaUnavailable
      || (targetKind === 'persona' && (
        loadingPersonaComposition
        || personaCompositionError
        || !selectedPersonaWorkReady
      ))
    ) {
      section = 'what';
      focusTarget = () => targetSelectionRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), [role="combobox"]:not([aria-disabled="true"]), input:not([disabled])',
      ) ?? targetSelectionRef.current;
    } else if (startRestriction === 'singleton' && overlapStrategy === 'parallel') {
      section = 'restrictions';
      focusTarget = () => restrictionCardRefs.current[1];
    }

    if (!section || !focusTarget) return false;
    handleSectionClick(section);
    window.setTimeout(() => focusTarget?.()?.focus(), 0);
    return true;
  };

  const handleSave = async () => {
    setSaveError(null);
    if (focusFirstInvalidControl()) return;
    setSaving(true);
    const input: PlannedExecutionInput = {
      name,
      flowId,
      prompt,
      saveConversations,
      overlapStrategy,
      startRestriction,
      superExclusive,
      emergency,
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
          m: { xs: 1, sm: 4 },
          width: { xs: 'calc(100% - 16px)', sm: '760px' },
          height: { xs: 'calc(100dvh - 16px)', sm: '90vh' },
          maxWidth: { xs: 'calc(100% - 16px)', sm: '95vw' },
          maxHeight: { xs: 'calc(100dvh - 16px)', sm: '90vh' },
          overflow: 'hidden',
        },
      }}
    >
      <DialogHeaderActions
        title={execution ? t('automations.modal.editTitle') : t('automations.modal.newTitle')}
        onClose={onClose}
      />

      <Divider />

      <DialogContent
        sx={{
          display: 'flex',
          flexDirection: 'column',
          p: 0,
          overflow: 'hidden',
          flexGrow: 1,
          minHeight: 0,
        }}
      >
        <Box sx={{ borderBottom: 1, borderColor: 'divider', px: { xs: 0, sm: 2 } }}>
          <Tabs
            value={activeSection}
            onChange={(_, value: ExecutionSection) => handleSectionClick(value)}
            variant="scrollable"
            scrollButtons="auto"
            aria-label={t('automations.modal.sectionsAria')}
          >
            {EXECUTION_SECTIONS.map((section) => (
              <Tab
                key={section}
                value={section}
                label={t(`automations.modal.section.${section}`)}
              />
            ))}
          </Tabs>
        </Box>
        <Box
          ref={scrollContainerRef}
          data-testid="execution-modal-scroll-container"
          sx={{
            flexGrow: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            p: { xs: 2, sm: 3 },
            scrollSnapType: 'y mandatory',
            scrollPaddingTop: { xs: '16px', sm: '24px' },
          }}
        >
          <Box
            ref={whenRef}
            data-section="when"
            sx={{ minHeight: 'calc(100% - 8px)', scrollSnapAlign: 'start', pb: 4 }}
          >
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('automations.modal.intro')}
        </Typography>

        <TextField
          fullWidth
          label={t('automations.modal.name')}
          inputRef={nameInputRef}
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

          </Box>
          <Box
            ref={whatRef}
            data-section="what"
            sx={{ minHeight: 'calc(100% - 8px)', scrollSnapAlign: 'start', pb: 4 }}
          >
            <Typography variant="h6" sx={{ mb: 1, fontWeight: 600 }}>
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
            <Box ref={targetSelectionRef} tabIndex={-1} sx={{ mt: 2 }}>
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
          <Box ref={targetSelectionRef} tabIndex={-1} sx={{ mt: 1 }}>
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
          </Box>

          <Box
            ref={restrictionsRef}
            data-section="restrictions"
            sx={{ minHeight: 'calc(100% - 8px)', scrollSnapAlign: 'start', pb: 4 }}
          >
            <Typography variant="h6" sx={{ mb: 0.5, fontWeight: 600 }}>
              {t('automations.modal.section.restrictions')}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t('automations.modal.restrictionsHelp')}
            </Typography>

            <Box
              role="radiogroup"
              aria-label={t('automations.modal.restrictionGroupAria')}
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
                gap: 1.5,
              }}
            >
              {START_RESTRICTIONS.map((restriction, index) => {
                const selected = startRestriction === restriction;
                const titleId = `automation-restriction-${restriction}-title`;
                const descriptionId = `automation-restriction-${restriction}-description`;
                return (
                  <Box
                    key={restriction}
                    component="button"
                    type="button"
                    ref={(element: HTMLButtonElement | null) => {
                      restrictionCardRefs.current[index] = element;
                    }}
                    role="radio"
                    aria-checked={selected}
                    aria-labelledby={titleId}
                    aria-describedby={descriptionId}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => selectStartRestriction(restriction)}
                    onKeyDown={(event: React.KeyboardEvent<HTMLButtonElement>) =>
                      handleRestrictionKeyDown(event, index)}
                    sx={{
                      appearance: 'none',
                      position: 'relative',
                      textAlign: 'left',
                      font: 'inherit',
                      color: 'text.primary',
                      bgcolor: selected ? 'action.selected' : 'background.paper',
                      border: 2,
                      borderColor: selected ? 'primary.main' : 'divider',
                      borderRadius: 2,
                      p: 2,
                      minHeight: 132,
                      cursor: 'pointer',
                      '&:focus-visible': {
                        outline: '3px solid',
                        outlineColor: 'primary.light',
                        outlineOffset: 2,
                      },
                    }}
                  >
                    {selected && (
                      <CheckCircleIcon
                        data-testid="restriction-selected-icon"
                        color="primary"
                        fontSize="small"
                        aria-hidden="true"
                        sx={{ position: 'absolute', top: 8, right: 8 }}
                      />
                    )}
                    <Typography
                      id={titleId}
                      variant="subtitle2"
                      sx={{ fontWeight: 700, mb: 0.75, pr: 3 }}
                    >
                      {t(`automations.modal.restriction.${restriction}.title`)}
                    </Typography>
                    <Typography id={descriptionId} variant="body2" color="text.secondary">
                      {t(`automations.modal.restriction.${restriction}.description`)}
                    </Typography>
                  </Box>
                );
              })}
            </Box>

            <FormControl fullWidth margin="normal">
              <InputLabel id="overlap-strategy-label">
                {t('automations.modal.alreadyRunning')}
              </InputLabel>
              <Select
                labelId="overlap-strategy-label"
                label={t('automations.modal.alreadyRunning')}
                value={overlapStrategy}
                onChange={(event) => setOverlapStrategy(event.target.value as OverlapStrategy)}
              >
                <MenuItem value="skip">{t('automations.modal.overlapSkip')}</MenuItem>
                <MenuItem value="queue">{t('automations.modal.overlapQueue')}</MenuItem>
                <MenuItem value="parallel" disabled={startRestriction === 'singleton'}>
                  {t('automations.modal.overlapParallel')}
                </MenuItem>
                <MenuItem value="error">{t('automations.modal.overlapError')}</MenuItem>
              </Select>
              <FormHelperText>
                {startRestriction === 'singleton'
                  ? t('automations.modal.singletonOverlapHelp')
                  : overlapStrategy === 'parallel'
                    && (trigger.type === 'url-watch' || trigger.type === 'mcp-poll')
                    ? t('automations.modal.parallelWarning')
                    : overlapStrategy === 'queue'
                      ? t('automations.modal.queueHelp')
                      : t('automations.modal.overlapHelp')}
              </FormHelperText>
            </FormControl>

            <Typography variant="subtitle1" sx={{ mt: 2, mb: 1, fontWeight: 600 }}>
              {t('automations.modal.overrides')}
            </Typography>
            <Box sx={{ display: 'grid', gap: 1.5 }}>
              <Box
                role="switch"
                aria-checked={superExclusive}
                aria-labelledby="automation-super-exclusive-title"
                aria-describedby="automation-super-exclusive-description"
                tabIndex={0}
                onClick={() => setSuperExclusive((value) => !value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSuperExclusive((value) => !value);
                  }
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  border: 2,
                  borderColor: superExclusive ? 'primary.main' : 'divider',
                  borderRadius: 2,
                  p: 2,
                  cursor: 'pointer',
                  '&:focus-visible': {
                    outline: '3px solid',
                    outlineColor: 'primary.light',
                    outlineOffset: 2,
                  },
                }}
              >
                <Switch
                  checked={superExclusive}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setSuperExclusive(event.target.checked)}
                  inputProps={{ 'aria-hidden': true, tabIndex: -1 }}
                />
                <Box>
                  <Typography
                    id="automation-super-exclusive-title"
                    variant="subtitle2"
                    sx={{ fontWeight: 700 }}
                  >
                    {t('automations.modal.superExclusiveTitle')}
                  </Typography>
                  <Typography
                    id="automation-super-exclusive-description"
                    variant="body2"
                    color="text.secondary"
                  >
                    {t('automations.modal.superExclusiveDescription')}
                  </Typography>
                </Box>
              </Box>

              <Box
                role="switch"
                aria-checked={emergency}
                aria-labelledby="automation-emergency-title"
                aria-describedby="automation-emergency-description"
                tabIndex={0}
                onClick={() => setEmergency((value) => !value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setEmergency((value) => !value);
                  }
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  border: 2,
                  borderColor: emergency ? 'error.main' : 'divider',
                  bgcolor: emergency ? 'action.hover' : 'background.paper',
                  borderRadius: 2,
                  p: 2,
                  cursor: 'pointer',
                  '&:focus-visible': {
                    outline: '3px solid',
                    outlineColor: 'error.light',
                    outlineOffset: 2,
                  },
                }}
              >
                <Switch
                  color="error"
                  checked={emergency}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setEmergency(event.target.checked)}
                  inputProps={{ 'aria-hidden': true, tabIndex: -1 }}
                />
                <Box>
                  <Typography
                    id="automation-emergency-title"
                    variant="subtitle2"
                    color="error.main"
                    sx={{ fontWeight: 800 }}
                  >
                    {t('automations.modal.emergencyTitle')}
                  </Typography>
                  <Typography
                    id="automation-emergency-description"
                    variant="body2"
                    color="text.secondary"
                  >
                    {t('automations.modal.emergencyDescription')}
                  </Typography>
                </Box>
              </Box>
            </Box>

            {superExclusive && (
              <FormControl fullWidth margin="normal">
                <InputLabel id="non-exclusive-behavior-label">
                  {t('automations.modal.otherTriggers')}
                </InputLabel>
                <Select
                  labelId="non-exclusive-behavior-label"
                  label={t('automations.modal.otherTriggers')}
                  value={nonExclusiveBehavior}
                  onChange={(event) =>
                    setNonExclusiveBehavior(event.target.value as 'queue' | 'skip' | 'error')
                  }
                >
                  <MenuItem value="queue">{t('automations.modal.othersQueue')}</MenuItem>
                  <MenuItem value="skip">{t('automations.modal.othersSkip')}</MenuItem>
                  <MenuItem value="error">{t('automations.modal.othersError')}</MenuItem>
                </Select>
                <FormHelperText>{t('automations.modal.superExclusiveBehaviorHelp')}</FormHelperText>
              </FormControl>
            )}
          </Box>
        </Box>

        {saveError && (
          <Alert severity="error" sx={{ m: 2, mt: 1 }}>
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
          disabled={saving}
        >
          {saving ? t('automations.modal.saving') : t('automations.modal.saveTrigger')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ExecutionModal;
