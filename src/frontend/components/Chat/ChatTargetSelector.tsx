"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import PersonOutlineRoundedIcon from '@mui/icons-material/PersonOutlineRounded';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';

import FlowSelector from './FlowSelector';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { personasService } from '@/frontend/services/personas';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type { Persona, PersonaComposition } from '@/shared/types/enduringAgent';
import { BIG_TUTORIAL_EVENT, isBigTutorialEvent } from '@/frontend/components/Tour/bigTutorialEvents';

interface ChatTargetSelectorProps {
  selectedFlowId: string | null;
  selectedPersonaId?: string | null;
  selectedPersonaBehaviorSlotKey?: string | null;
  onSelectFlow: (flowId: string) => void;
  onSelectPersona: (personaId: string, behaviorSlotKey: string) => void;
  disabled?: boolean;
  compact?: boolean;
  fullScreenPicker?: boolean;
}

const personaCanReceiveChat = (persona: Persona): boolean =>
  persona.provisioningState !== 'pending'
  && persona.lifecycleState !== 'disabled'
  && persona.lifecycleState !== 'error';

const ChatTargetSelector: React.FC<ChatTargetSelectorProps> = ({
  selectedFlowId,
  selectedPersonaId = null,
  selectedPersonaBehaviorSlotKey = null,
  onSelectFlow,
  onSelectPersona,
  disabled = false,
  compact = false,
  fullScreenPicker = false,
}) => {
  const { t } = useI18n();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [candidatePersona, setCandidatePersona] = useState<Persona | null>(null);
  const [candidateComposition, setCandidateComposition] = useState<PersonaComposition | null>(null);
  const [compositionLoading, setCompositionLoading] = useState(false);
  const [compositionError, setCompositionError] = useState<string | null>(null);
  const [compositionAttempt, setCompositionAttempt] = useState(0);
  const [selectedBehaviorName, setSelectedBehaviorName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'agents' | 'personas'>('agents');
  const [selectedFlowName, setSelectedFlowName] = useState('');
  const [externalAgentSearch, setExternalAgentSearch] = useState<string | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    if (typeof fetch !== 'function') {
      setError(t('chat.target.loadFailed'));
      setLoading(false);
      return () => controller.abort();
    }
    fetch(withWorkspaceUrl('/v1/personas'), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Persona list failed (${response.status})`);
        return response.json() as Promise<Persona[]>;
      })
      .then((items) => setPersonas(Array.isArray(items) ? items : []))
      .catch((cause) => {
        if ((cause as { name?: string })?.name !== 'AbortError') {
          setError(t('chat.target.loadFailed'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [t]);

  useEffect(() => {
    if (!candidatePersona) {
      setCandidateComposition(null);
      setCompositionError(null);
      setCompositionLoading(false);
      return;
    }
    let cancelled = false;
    setCandidateComposition(null);
    setCompositionError(null);
    setCompositionLoading(true);
    void personasService.getComposition(candidatePersona.id)
      .then((composition) => {
        if (!cancelled) setCandidateComposition(composition);
      })
      .catch(() => {
        if (!cancelled) setCompositionError(t('chat.target.behaviorsLoadFailed'));
      })
      .finally(() => {
        if (!cancelled) setCompositionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [candidatePersona, compositionAttempt, t]);

  useEffect(() => {
    if (
      !selectedPersonaId
      || !selectedPersonaBehaviorSlotKey
      || selectedPersonaBehaviorSlotKey === 'primary'
    ) {
      setSelectedBehaviorName(null);
      return;
    }
    let cancelled = false;
    setSelectedBehaviorName(null);
    void personasService.getComposition(selectedPersonaId)
      .then((composition) => {
        if (cancelled) return;
        setSelectedBehaviorName(
          composition.behaviorCards.find(
            (behavior) => behavior.slotKey === selectedPersonaBehaviorSlotKey,
          )?.name ?? null,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedPersonaBehaviorSlotKey, selectedPersonaId]);

  useEffect(() => {
    const listener = (event: Event) => {
      if (!isBigTutorialEvent(event) || event.detail.type !== 'open-chat-flow-picker') return;
      setActiveTab('agents');
      setExternalAgentSearch(event.detail.query);
      setOpen(true);
    };
    window.addEventListener(BIG_TUTORIAL_EVENT, listener);
    return () => window.removeEventListener(BIG_TUTORIAL_EVENT, listener);
  }, []);

  const availablePersonas = useMemo(
    () => personas.filter(personaCanReceiveChat),
    [personas],
  );
  const selectedPersona = personas.find((persona) => persona.id === selectedPersonaId);

  const closePicker = () => {
    setOpen(false);
    setCandidatePersona(null);
  };

  const openPicker = () => {
    setCandidatePersona(null);
    setActiveTab('agents');
    setExternalAgentSearch(undefined);
    setOpen(true);
  };

  const chooseFlow = (flowId: string) => {
    onSelectFlow(flowId);
    closePicker();
  };

  const choosePersonaBehavior = (behaviorSlotKey: string) => {
    if (!candidatePersona) return;
    onSelectPersona(candidatePersona.id, behaviorSlotKey);
    closePicker();
  };

  if (selectedPersonaId) {
    const personaLabel = selectedPersona?.name ?? t('chat.target.persona');
    const behaviorLabel = selectedPersonaBehaviorSlotKey === 'primary'
      ? t('chat.target.mainRole')
      : selectedBehaviorName ?? t('chat.target.specialistBehavior');
    const label = selectedPersonaBehaviorSlotKey
      ? `${personaLabel} · ${behaviorLabel}`
      : personaLabel;
    return (
      <Tooltip title={t('chat.target.locked')}>
        <span>
          <Button
            variant="outlined"
            size={compact ? 'small' : 'medium'}
            startIcon={<PersonOutlineRoundedIcon />}
            endIcon={<LockOutlinedIcon fontSize="small" />}
            disabled
            sx={{ textTransform: 'none', maxWidth: '100%', minWidth: 0 }}
          >
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {label}
            </Box>
          </Button>
        </span>
      </Tooltip>
    );
  }

  return (
    <Box sx={{ minWidth: 0 }}>
      <Tooltip title={t('chat.target.chooseTarget')}>
        <span>
          <Button
            data-tour="chat-flow-picker-button"
            variant="outlined"
            size={compact ? 'small' : 'medium'}
            startIcon={<AccountTreeOutlinedIcon />}
            disabled={disabled}
            onClick={openPicker}
            sx={{
              textTransform: 'none',
              maxWidth: '100%',
              minWidth: 0,
              ...(compact && { minHeight: 36, px: 1.25 }),
            }}
          >
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedFlowId ? selectedFlowName || t('chat.selector.title') : t('chat.target.chooseTarget')}
            </Box>
          </Button>
        </span>
      </Tooltip>

      <Dialog
        open={open}
        onClose={closePicker}
        fullScreen={fullScreenPicker}
        fullWidth
        maxWidth="md"
        keepMounted
      >
        <DialogTitle>{t('chat.target.chooseTarget')}</DialogTitle>
        <Box sx={{ borderBottom: 1, borderColor: 'divider', px: { xs: 1, sm: 3 } }}>
          <Tabs
            value={activeTab}
            onChange={(_event, value: 'agents' | 'personas') => setActiveTab(value)}
            aria-label={t('chat.target.tabs')}
          >
            <Tab value="agents" label={t('chat.target.agents')} />
            <Tab value="personas" label={t('chat.target.personas')} />
          </Tabs>
        </Box>
        <DialogContent dividers sx={{ p: { xs: 2, sm: 3 } }}>
          {activeTab === 'agents' ? (
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {t('chat.selector.dialogHelp')}
              </Typography>
              <FlowSelector
                embedded
                selectedFlowId={selectedFlowId}
                onSelectFlow={chooseFlow}
                externalSearchTerm={externalAgentSearch}
                onSelectedFlowNameChange={setSelectedFlowName}
              />
            </Box>
          ) : candidatePersona ? (
            <Box>
              <Typography variant="h6" sx={{ mb: 1 }}>
                {t('chat.target.chooseHow', { persona: candidatePersona.name })}
              </Typography>
              <Button
                size="small"
                onClick={() => setCandidatePersona(null)}
                sx={{ mb: 1.5, textTransform: 'none' }}
              >
                {t('chat.target.backToPersonas')}
              </Button>
              {compositionLoading ? (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 3 }}>
                  <CircularProgress size={20} />
                  <Typography color="text.secondary">{t('chat.target.loadingBehaviors')}</Typography>
                </Box>
              ) : compositionError ? (
                <Alert
                  severity="error"
                  action={(
                    <Button color="inherit" size="small" onClick={() => setCompositionAttempt((value) => value + 1)}>
                      {t('chat.target.retry')}
                    </Button>
                  )}
                >
                  {compositionError}
                </Alert>
              ) : candidateComposition ? (
                <>
                  <List disablePadding>
                    <ListItemButton
                      onClick={() => choosePersonaBehavior('primary')}
                      disabled={candidateComposition.core?.readiness.state !== 'ready'}
                    >
                      <ListItemText
                        primary={t('chat.target.mainRole')}
                        secondary={candidateComposition.core?.readiness.state === 'ready'
                          ? t('chat.target.mainRoleHelp')
                          : t('chat.target.notReady')}
                      />
                      <Chip size="small" label={t('chat.target.recommended')} color="primary" variant="outlined" />
                    </ListItemButton>
                  </List>
                  <Typography variant="subtitle2" sx={{ mt: 2.5, mb: 0.5 }}>
                    {t('chat.target.specialistBehaviors')}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    {t('chat.target.specialistHelp')}
                  </Typography>
                  {candidateComposition.behaviorCards.length === 0 ? (
                    <Typography color="text.secondary">{t('chat.target.noBehaviors')}</Typography>
                  ) : (
                    <List disablePadding>
                      {[...candidateComposition.behaviorCards]
                        .sort((left, right) => left.order - right.order)
                        .map((behavior) => (
                          <ListItemButton
                            key={behavior.ref}
                            onClick={() => choosePersonaBehavior(behavior.slotKey)}
                            disabled={behavior.readiness.state !== 'ready'}
                          >
                            <ListItemText
                              primary={behavior.name}
                              secondary={behavior.readiness.state === 'ready'
                                ? behavior.description || t('chat.target.specialistBehavior')
                                : t('chat.target.notReady')}
                            />
                          </ListItemButton>
                        ))}
                    </List>
                  )}
                </>
              ) : null}
            </Box>
          ) : loading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 3 }}>
              <CircularProgress size={20} />
              <Typography color="text.secondary">{t('chat.target.loading')}</Typography>
            </Box>
          ) : error ? (
            <Alert severity="error">{error}</Alert>
          ) : availablePersonas.length === 0 ? (
            <Typography color="text.secondary">{t('chat.target.empty')}</Typography>
          ) : (
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                {t('chat.target.choosePersona')}
              </Typography>
              <List disablePadding>
                {availablePersonas.map((persona) => (
                  <ListItemButton
                    key={persona.id}
                    onClick={() => setCandidatePersona(persona)}
                    selected={persona.id === selectedPersonaId}
                  >
                    <PersonOutlineRoundedIcon sx={{ mr: 1.5, color: 'primary.main' }} />
                    <ListItemText primary={persona.name} secondary={persona.mission || undefined} />
                  </ListItemButton>
                ))}
              </List>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closePicker}>{t('common.cancel')}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default ChatTargetSelector;
