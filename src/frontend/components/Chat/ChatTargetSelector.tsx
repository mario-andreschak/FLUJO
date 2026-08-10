"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material';
import PersonOutlineRoundedIcon from '@mui/icons-material/PersonOutlineRounded';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';

import FlowSelector from './FlowSelector';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type { Persona } from '@/shared/types/enduringAgent';

interface ChatTargetSelectorProps {
  selectedFlowId: string | null;
  selectedPersonaId?: string | null;
  onSelectFlow: (flowId: string) => void;
  onSelectPersona: (personaId: string) => void;
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

  const availablePersonas = useMemo(
    () => personas.filter(personaCanReceiveChat),
    [personas],
  );
  const selectedPersona = personas.find((persona) => persona.id === selectedPersonaId);

  if (selectedPersonaId) {
    const label = selectedPersona?.name ?? selectedPersonaId;
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
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', minWidth: 0 }}>
      <FlowSelector
        selectedFlowId={selectedFlowId}
        onSelectFlow={onSelectFlow}
        disabled={disabled}
        hideLabel
        compact={compact}
        fullScreenPicker={fullScreenPicker}
      />
      <Tooltip title={error ?? t('chat.target.choosePersona')}>
        <span>
          <Button
            variant="outlined"
            size={compact ? 'small' : 'medium'}
            startIcon={loading ? <CircularProgress size={16} /> : <PersonOutlineRoundedIcon />}
            disabled={disabled || loading || Boolean(error)}
            onClick={() => setOpen(true)}
            sx={{ textTransform: 'none', minHeight: compact ? 36 : undefined }}
          >
            {t('chat.target.persona')}
          </Button>
        </span>
      </Tooltip>

      <Dialog open={open} onClose={() => setOpen(false)} fullScreen={fullScreenPicker} fullWidth maxWidth="sm">
        <DialogTitle>{t('chat.target.choosePersona')}</DialogTitle>
        <DialogContent dividers>
          {error ? (
            <Alert severity="error">{error}</Alert>
          ) : availablePersonas.length === 0 ? (
            <Typography color="text.secondary">{t('chat.target.empty')}</Typography>
          ) : (
            <List disablePadding>
              {availablePersonas.map((persona) => (
                <ListItemButton
                  key={persona.id}
                  onClick={() => {
                    onSelectPersona(persona.id);
                    setOpen(false);
                  }}
                  selected={persona.id === selectedPersonaId}
                >
                  <PersonOutlineRoundedIcon sx={{ mr: 1.5, color: 'primary.main' }} />
                  <ListItemText primary={persona.name} secondary={persona.mission || persona.id} />
                  <Chip size="small" label={persona.lifecycleState} variant="outlined" />
                </ListItemButton>
              ))}
            </List>
          )}
        </DialogContent>
      </Dialog>
    </Box>
  );
};

export default ChatTargetSelector;
