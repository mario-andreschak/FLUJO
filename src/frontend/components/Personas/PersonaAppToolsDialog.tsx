'use client';

import { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import MCPNodeToolList from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/MCPNodeToolList';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useServerTools } from '@/frontend/hooks/useServerTools';
import type { PersonaAppGrant } from '@/shared/types/enduringAgent';
import type { MCPToolParameterPresets } from '@/shared/types/mcp';

interface PersonaAppToolsDialogProps {
  open: boolean;
  grant: PersonaAppGrant | null;
  workspaceRoots?: string[];
  busy: boolean;
  onClose: () => void;
  onSave: (value: {
    enabledTools: string[];
    toolParameterPresets: MCPToolParameterPresets;
  }) => Promise<boolean>;
}

export default function PersonaAppToolsDialog({
  open,
  grant,
  workspaceRoots,
  busy,
  onClose,
  onSave,
}: PersonaAppToolsDialogProps) {
  const { t } = useI18n();
  const serverName = open && grant ? grant.mcpServerName : null;
  const { tools, toolsServerName, isLoading, error, retryLoadTools } = useServerTools(serverName);
  const [enabledTools, setEnabledTools] = useState<string[]>([]);
  const [toolParameterPresets, setToolParameterPresets] = useState<MCPToolParameterPresets>({});
  const [saving, setSaving] = useState(false);
  const initializedGrantRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      initializedGrantRef.current = null;
      return;
    }
    if (!grant || toolsServerName !== grant.mcpServerName) return;
    const grantRevision = `${grant.id}:${grant.updatedAt}`;
    if (initializedGrantRef.current === grantRevision) return;
    const liveToolNames = new Set(tools.map((tool) => tool.name));
    setEnabledTools(grant.enabledTools === undefined
      ? tools.map((tool) => tool.name)
      : grant.enabledTools.filter((toolName) => liveToolNames.has(toolName)));
    setToolParameterPresets(grant.toolParameterPresets ?? {});
    initializedGrantRef.current = grantRevision;
  }, [grant, open, tools, toolsServerName]);

  const save = async () => {
    setSaving(true);
    try {
      if (await onSave({ enabledTools, toolParameterPresets })) onClose();
    } finally {
      setSaving(false);
    }
  };

  const pending = busy || saving;
  const ready = !!grant && toolsServerName === grant.mcpServerName && !isLoading;

  return (
    <Dialog open={open} fullWidth maxWidth="lg" onClose={pending ? undefined : onClose}>
      <DialogTitle>
        {t('personas.apps.toolsTitle', { server: grant?.mcpServerName ?? '' })}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography color="text.secondary">{t('personas.apps.toolsHelp')}</Typography>
          {isLoading && (
            <Stack direction="row" spacing={1.5} alignItems="center">
              <CircularProgress size={22} />
              <Typography color="text.secondary">{t('personas.loading')}</Typography>
            </Stack>
          )}
          {error && (
            <Alert
              severity="warning"
              action={<Button onClick={retryLoadTools}>{t('personas.retry')}</Button>}
            >
              {error || t('personas.apps.toolsLoadFailed')}
            </Alert>
          )}
          {ready && !error && (
            <MCPNodeToolList
              tools={tools}
              enabledTools={enabledTools}
              onToggle={(toolName) => setEnabledTools((current) => (
                current.includes(toolName)
                  ? current.filter((candidate) => candidate !== toolName)
                  : [...current, toolName]
              ))}
              onActivateAll={() => setEnabledTools(tools.map((tool) => tool.name))}
              onDeactivateAll={() => setEnabledTools([])}
              allowedToolsTitle={t('personas.apps.allowedTools')}
              toolsHelp={t('personas.apps.allowedToolsHelp')}
              parameterPresets={toolParameterPresets}
              onParameterPresetsChange={setToolParameterPresets}
              parameterPresetsTitle={t('personas.apps.toolParametersTitle')}
              parameterPresetsDescription={t('personas.apps.toolParametersHelp')}
              workspaceRoots={workspaceRoots}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>{t('personas.action.cancel')}</Button>
        <Button variant="contained" onClick={() => void save()} disabled={pending || !ready || !!error}>
          {t('personas.action.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
