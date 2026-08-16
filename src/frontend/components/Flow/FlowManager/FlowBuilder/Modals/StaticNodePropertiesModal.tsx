"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  Divider,
  FormControlLabel,
  FormHelperText,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import AlternateEmailRoundedIcon from '@mui/icons-material/AlternateEmailRounded';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import AttachFileRoundedIcon from '@mui/icons-material/AttachFileRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import BuildRoundedIcon from '@mui/icons-material/BuildRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import DeleteIcon from '@mui/icons-material/Delete';
import DnsRoundedIcon from '@mui/icons-material/DnsRounded';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ForumRoundedIcon from '@mui/icons-material/ForumRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded';
import SmartToyRoundedIcon from '@mui/icons-material/SmartToyRounded';
import type { FlowNode } from '@/frontend/types/flow/flow';
import type { MCPToolResponse } from '@/shared/types/mcp';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { useServerTools } from '@/frontend/hooks/useServerTools';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import { mcpService } from '@/frontend/services/mcp';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import GlobalReferenceEditor from '@/frontend/components/shared/GlobalReferenceEditor';
import SchemaParamsForm from '@/frontend/components/shared/SchemaParamsForm';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import type { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';
import type { CardGroup } from '@/utils/shared/cardGrouping';
import {
  createPromptReferenceSuggestion,
  type PromptReferenceSuggestion,
} from '@/utils/shared/promptRefs';

interface StaticNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: FlowNode['data']) => void;
}

interface StaticAttachment {
  id: string;
  type: 'document' | 'audio' | 'image' | 'video';
  content: string;
  originalName?: string;
  mimeType?: string;
  transcript?: string;
}

type StaticEntry =
  | {
      kind: 'message';
      role: 'system' | 'user' | 'assistant';
      content: string;
      attachments?: StaticAttachment[];
    }
  | {
      kind: 'toolCall';
      toolName: string;
      argumentsJson: string;
      result: string;
      executionMode?: 'mock' | 'real';
      serverName?: string;
    };

const EMPTY_STATIC_ENTRIES: StaticEntry[] = [];

const roleMeta = {
  system: { color: '#7c3aed', icon: <SettingsRoundedIcon fontSize="small" /> },
  user: { color: '#2563eb', icon: <ForumRoundedIcon fontSize="small" /> },
  assistant: { color: '#059669', icon: <SmartToyRoundedIcon fontSize="small" /> },
} as const;

const roleTranslationKey = {
  system: 'flows.static.role.system',
  user: 'flows.static.role.user',
  assistant: 'flows.static.role.assistant',
} as const;

const messagePlaceholderKey = {
  system: 'flows.static.messagePlaceholder.system',
  user: 'flows.static.messagePlaceholder.user',
  assistant: 'flows.static.messagePlaceholder.assistant',
} as const;

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readFile(file: File): Promise<StaticAttachment> {
  const mimeType = file.type || 'application/octet-stream';
  const textLike = mimeType.startsWith('text/')
    || /\.(txt|md|json|csv|html?|xml|js|ts|jsx|tsx|css|scss)$/i.test(file.name);
  const type: StaticAttachment['type'] = mimeType.startsWith('image/') ? 'image'
    : mimeType.startsWith('audio/') ? 'audio'
      : mimeType.startsWith('video/') ? 'video'
        : 'document';
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      id: crypto.randomUUID(),
      type,
      content: String(reader.result ?? ''),
      originalName: file.name,
      mimeType,
    });
    reader.onerror = reject;
    if (textLike) reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

interface MessageComposerProps {
  entry: Extract<StaticEntry, { kind: 'message' }>;
  onChange: (patch: Partial<Extract<StaticEntry, { kind: 'message' }>>) => void;
  globalNames: string[];
  suggestions: PromptReferenceSuggestion[];
}

const MessageComposer = ({ entry, onChange, globalNames, suggestions }: MessageComposerProps) => {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const meta = roleMeta[entry.role];
  const roleLabel = t(roleTranslationKey[entry.role]);
  const attachments = entry.attachments ?? [];

  const addFiles = async (files: File[]) => {
    const next = await Promise.all(files.map(readFile));
    onChange({ attachments: [...attachments, ...next] });
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const images = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .flatMap((item) => item.getAsFile() ? [item.getAsFile() as File] : []);
    if (images.length === 0) return;
    event.preventDefault();
    void addFiles(images);
  };

  return (
    <Paper
      variant="outlined"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) setIsDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDraggingFiles(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDraggingFiles(false);
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 0) void addFiles(files);
      }}
      sx={{
        p: 1.5,
        borderRadius: 3,
        borderColor: isDraggingFiles ? meta.color : alpha(meta.color, 0.3),
        borderStyle: isDraggingFiles ? 'dashed' : 'solid',
        boxShadow: isDraggingFiles ? `0 0 0 3px ${alpha(meta.color, 0.12)}` : 'none',
        background: (theme) => `linear-gradient(135deg, ${alpha(meta.color, theme.palette.mode === 'dark' ? 0.12 : 0.05)}, transparent 42%)`,
      }}
    >
      <Stack direction="row" spacing={1.25} alignItems="flex-start">
        <Avatar sx={{ width: 34, height: 34, bgcolor: meta.color }}>{meta.icon}</Avatar>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <TextField
              select
              size="small"
              value={entry.role}
              onChange={(event) => onChange({ role: event.target.value as typeof entry.role })}
              sx={{ minWidth: 142, '& .MuiInputBase-root': { borderRadius: 2 } }}
              inputProps={{ 'aria-label': 'Message role' }}
            >
              <MenuItem value="system">{t('flows.static.role.system')}</MenuItem>
              <MenuItem value="user">{t('flows.static.role.user')}</MenuItem>
              <MenuItem value="assistant">{t('flows.static.role.assistant')}</MenuItem>
            </TextField>
            <Chip
              size="small"
              icon={<AlternateEmailRoundedIcon />}
              label={t('flows.static.typeAtReferences')}
              variant="outlined"
              sx={{ color: 'text.secondary' }}
            />
          </Stack>

          {attachments.length > 0 && (
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1, mb: 1 }}>
              {attachments.map((attachment) => (
                <Chip
                  key={attachment.id}
                  size="small"
                  variant="outlined"
                  icon={<AttachFileRoundedIcon />}
                  label={attachment.originalName || attachment.type}
                  onDelete={() => onChange({ attachments: attachments.filter((item) => item.id !== attachment.id) })}
                />
              ))}
            </Stack>
          )}

          <Box
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: 2.5,
              bgcolor: 'background.paper',
              p: 1,
              '&:focus-within': { borderColor: meta.color, boxShadow: `0 0 0 3px ${alpha(meta.color, 0.12)}` },
            }}
          >
            <GlobalReferenceEditor
              value={entry.content}
              onChange={(content) => onChange({ content })}
              globalNames={globalNames}
              suggestions={suggestions}
              enhancedHitlist
              multiline
              minRows={3}
              maxRows={10}
              bare
              onPaste={handlePaste}
              ariaLabel={t('flows.static.messageAria', { role: roleLabel })}
              placeholder={t(messagePlaceholderKey[entry.role])}
            />
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 0.75 }}>
              <Typography variant="caption" color="text.secondary">
                {t('flows.static.referencesHelp')}
              </Typography>
              <Tooltip title={t('flows.static.attachHelp')}>
                <IconButton size="small" onClick={() => fileInputRef.current?.click()} aria-label={t('flows.static.attach')}>
                  <AttachFileRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </Box>
          <input
            hidden
            multiple
            ref={fileInputRef}
            type="file"
            accept="image/*,audio/*,video/*,.pdf,.txt,.md,.json,.csv,.html,.xml,.js,.ts,.jsx,.tsx,.css,.scss"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              if (files.length > 0) void addFiles(files);
            }}
          />
        </Box>
      </Stack>
    </Paper>
  );
};

interface ToolCallEditorProps {
  entry: Extract<StaticEntry, { kind: 'toolCall' }>;
  onChange: (patch: Partial<Extract<StaticEntry, { kind: 'toolCall' }>>) => void;
  onChooseServer: () => void;
}

const ToolCallEditor = ({ entry, onChange, onChooseServer }: ToolCallEditorProps) => {
  const { t } = useI18n();
  const serverName = entry.serverName ?? '';
  const executionMode = entry.executionMode === 'real' ? 'real' : 'mock';
  const { tools, isLoading, error } = useServerTools(serverName || null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const params = useMemo(() => parseArguments(entry.argumentsJson), [entry.argumentsJson]);
  const selectedTool = tools.find((tool) => tool.name === entry.toolName) as MCPToolResponse | undefined;

  const executeAndCapture = async () => {
    if (!serverName || !entry.toolName) return;
    setRunning(true);
    setRunError(null);
    try {
      const response = await mcpService.callTool(serverName, entry.toolName, params);
      if (response.error || response.success === false) {
        setRunError(response.error || 'The tool returned an error.');
        return;
      }
      onChange({
        executionMode: 'mock',
        argumentsJson: JSON.stringify(params, null, 2),
        result: JSON.stringify(response.data ?? response, null, 2),
      });
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : 'The tool could not be executed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Stack spacing={2.25}>
      <ToggleButtonGroup
        exclusive
        fullWidth
        size="small"
        value={executionMode}
        onChange={(_, value: 'real' | 'mock' | null) => value && onChange({ executionMode: value })}
        aria-label={t('flows.static.toolCallBehavior')}
        sx={{ '& .MuiToggleButton-root': { py: 1.1, textTransform: 'none', fontWeight: 700 } }}
      >
        <ToggleButton value="real">
          <PlayArrowRoundedIcon fontSize="small" sx={{ mr: 0.75 }} /> {t('flows.static.realCall')}
        </ToggleButton>
        <ToggleButton value="mock">
          <AutoAwesomeRoundedIcon fontSize="small" sx={{ mr: 0.75 }} /> {t('flows.static.mockCall')}
        </ToggleButton>
      </ToggleButtonGroup>

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2.5 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="overline" color="text.secondary">1 · {t('flows.static.mcpServer')}</Typography>
            <Button
              fullWidth
              variant={serverName ? 'outlined' : 'contained'}
              color="info"
              onClick={onChooseServer}
              startIcon={<DnsRoundedIcon />}
              sx={{ mt: 0.5, justifyContent: 'flex-start', py: 1.25, borderRadius: 2, textTransform: 'none' }}
            >
              {serverName || t('flows.static.chooseServer')}
            </Button>
          </Box>

          <Box>
            <Typography variant="overline" color="text.secondary">2 · {t('flows.static.tool')}</Typography>
            <TextField
              select
              fullWidth
              size="small"
              value={entry.toolName}
              disabled={!serverName || isLoading}
              onChange={(event) => onChange({ toolName: event.target.value, argumentsJson: '{}', result: '' })}
              helperText={isLoading ? t('flows.static.loadingTools') : error || selectedTool?.description || t('flows.static.toolHelp')}
              error={!!error || (!!serverName && !isLoading && !entry.toolName)}
              sx={{ mt: 0.5 }}
            >
              <MenuItem value=""><em>{t('flows.static.chooseTool')}</em></MenuItem>
              {!!entry.toolName && !selectedTool && (
                <MenuItem value={entry.toolName}>{t('flows.static.savedTool', { tool: entry.toolName })}</MenuItem>
              )}
              {tools.map((tool) => (
                <MenuItem key={tool.name} value={tool.name}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={700}>{tool.name}</Typography>
                    {tool.description && (
                      <Typography variant="caption" color="text.secondary" noWrap>{tool.description}</Typography>
                    )}
                  </Box>
                </MenuItem>
              ))}
            </TextField>
          </Box>

          <Box>
            <Typography variant="overline" color="text.secondary">3 · {t('flows.static.parameters')}</Typography>
            <Box sx={{ mt: 0.75 }}>
              {selectedTool ? (
                <SchemaParamsForm
                  schema={selectedTool.inputSchema as Record<string, unknown>}
                  values={params}
                  onChange={(values) => onChange({ argumentsJson: JSON.stringify(values, null, 2) })}
                />
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t('flows.static.parametersHelp')}
                </Typography>
              )}
            </Box>
          </Box>
        </Stack>
      </Paper>

      <Accordion disableGutters elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: '10px !important' }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle2">{t('flows.static.rawArguments')}</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <TextField
            fullWidth
            multiline
            minRows={3}
            value={entry.argumentsJson}
            onChange={(event) => onChange({ argumentsJson: event.target.value })}
            error={entry.argumentsJson.trim() !== '' && (() => { try { JSON.parse(entry.argumentsJson); return false; } catch { return true; } })()}
            helperText={t('flows.static.rawArgumentsHelp')}
            inputProps={{ style: { fontFamily: 'monospace' } }}
          />
        </AccordionDetails>
      </Accordion>

      {executionMode === 'mock' ? (
        <Paper
          variant="outlined"
          sx={{ p: 2, borderRadius: 2.5, borderColor: (theme) => alpha(theme.palette.secondary.main, 0.32) }}
        >
          <Stack spacing={1.5}>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} justifyContent="space-between" alignItems={{ sm: 'center' }}>
              <Box>
                <Typography variant="subtitle2">{t('flows.static.mockResult')}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('flows.static.mockResultHelp')}
                </Typography>
              </Box>
              <Button
                variant="contained"
                color="secondary"
                startIcon={running ? <CircularProgress size={16} color="inherit" /> : <PlayArrowRoundedIcon />}
                disabled={running || !serverName || !entry.toolName}
                onClick={() => void executeAndCapture()}
                sx={{ whiteSpace: 'nowrap', textTransform: 'none' }}
              >
                {running ? t('flows.static.executing') : t('flows.static.runUseMock')}
              </Button>
            </Stack>
            {runError && <Alert severity="error">{runError}</Alert>}
            <TextField
              fullWidth
              multiline
              minRows={4}
              value={entry.result}
              onChange={(event) => onChange({ result: event.target.value })}
              placeholder={t('flows.static.mockResultPlaceholder')}
              inputProps={{ style: { fontFamily: 'monospace' } }}
            />
          </Stack>
        </Paper>
      ) : (
        <Alert severity="info" icon={<CheckCircleRoundedIcon />}>
          {t('flows.static.realCallHelpBefore')} <strong>{serverName || t('flows.static.selectedServer')}</strong> {t('flows.static.realCallHelpAfter')}
        </Alert>
      )}
    </Stack>
  );
};

export const StaticNodePropertiesModal = ({ open, node, onClose, onSave }: StaticNodePropertiesModalProps) => {
  const { t } = useI18n();
  const { globalEnvVars } = useStorage();
  const globalNames = useMemo(() => Object.entries(globalEnvVars)
    .filter(([, value]) => !value.metadata?.isSecret)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b)), [globalEnvVars]);
  const [nodeData, setNodeData] = useState<FlowNode['data'] | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set());
  const [serverPickerEntry, setServerPickerEntry] = useState<number | null>(null);
  const [toolReferenceSuggestions, setToolReferenceSuggestions] = useState<PromptReferenceSuggestion[]>([]);
  const { servers, isLoading: loadingServers, loadError } = useServerStatus();
  const serverPicker = useCardPicker<any>('mcp', servers);

  useEffect(() => {
    if (!node) return;
    const initialEntries = Array.isArray(node.data.properties?.entries)
      ? node.data.properties.entries.map((entry: StaticEntry) => entry.kind === 'toolCall'
        ? { executionMode: 'mock' as const, ...entry }
        : { ...entry, attachments: [...(entry.attachments ?? [])] })
      : [];
    setNodeData({ ...node.data, properties: { ...node.data.properties, entries: initialEntries } });
    setExpandedEntries(new Set(initialEntries.map((_: StaticEntry, index: number) => index)));
    setServerPickerEntry(null);
  }, [node, open]);

  const entries = (nodeData?.properties?.entries ?? EMPTY_STATIC_ENTRIES) as StaticEntry[];
  const realToolRefs = useMemo(() => entries
    .filter((entry): entry is Extract<StaticEntry, { kind: 'toolCall' }> => entry.kind === 'toolCall'
      && entry.executionMode === 'real'
      && !!entry.serverName?.trim()
      && !!entry.toolName.trim())
    .map((entry) => ({ server: entry.serverName!.trim(), tool: entry.toolName.trim() }))
    .sort((a, b) => `${a.server}:${a.tool}`.localeCompare(`${b.server}:${b.tool}`)), [entries]);

  useEffect(() => {
    let cancelled = false;
    if (!open || realToolRefs.length === 0) {
      setToolReferenceSuggestions([]);
      return () => { cancelled = true; };
    }
    const toolsByServer = new Map<string, Set<string>>();
    for (const ref of realToolRefs) {
      const names = toolsByServer.get(ref.server) ?? new Set<string>();
      names.add(ref.tool);
      toolsByServer.set(ref.server, names);
    }
    void Promise.all([...toolsByServer].map(async ([server, enabledTools]) => {
      try {
        const result = await mcpService.listServerTools(server);
        return (result.tools ?? [])
          .filter((tool: MCPToolResponse) => enabledTools.has(tool.name))
          .map((tool: MCPToolResponse) => createPromptReferenceSuggestion(
            { kind: 'tool', server, name: tool.name },
            tool.name,
            tool.description || server,
          ));
      } catch {
        return [];
      }
    })).then((groups) => {
      if (!cancelled) setToolReferenceSuggestions(groups.flat());
    });
    return () => { cancelled = true; };
  }, [open, realToolRefs]);

  const setEntries = (next: StaticEntry[]) => setNodeData((previous) => previous
    ? { ...previous, properties: { ...previous.properties, entries: next } }
    : previous);
  const updateEntry = (index: number, patch: Record<string, unknown>) => setEntries(
    entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } as StaticEntry : entry),
  );
  const removeEntry = (index: number) => setEntries(entries.filter((_, entryIndex) => entryIndex !== index));
  const moveEntry = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    const next = [...entries];
    [next[index], next[target]] = [next[target], next[index]];
    setEntries(next);
  };
  const appendEntry = (entry: StaticEntry) => {
    setEntries([...entries, entry]);
    setExpandedEntries((current) => new Set([...current, entries.length]));
  };

  const invalidJsonIndexes = entries.flatMap((entry, index) => {
    if (entry.kind !== 'toolCall') return [];
    const raw = entry.argumentsJson.trim();
    if (!raw || /\$\{(?:var|res):[^}]*\}/.test(raw)) return [];
    try { JSON.parse(raw); return []; } catch { return [index]; }
  });
  const incompleteToolIndexes = entries.flatMap((entry, index) => entry.kind === 'toolCall'
    && !entry.toolName.trim() ? [index] : []);
  const incompleteRealIndexes = entries.flatMap((entry, index) => entry.kind === 'toolCall'
    && entry.executionMode === 'real'
    && !entry.serverName?.trim() ? [index] : []);
  const cannotSave = invalidJsonIndexes.length > 0
    || incompleteToolIndexes.length > 0
    || incompleteRealIndexes.length > 0;

  if (!node || !nodeData) return null;

  const renderServerCard = (server: any) => (
    <ServerCard
      name={server.name}
      status={(server.status as any) || 'disconnected'}
      path={server.path || server.rootPath || ''}
      enabled={!server.disabled}
      transport={(server.transport as any) || 'stdio'}
      pickerMode
      selected={serverPickerEntry !== null && entries[serverPickerEntry]?.kind === 'toolCall'
        && entries[serverPickerEntry].serverName === server.name}
      onClick={() => {
        if (serverPickerEntry !== null) updateEntry(serverPickerEntry, { serverName: server.name, toolName: '', argumentsJson: '{}', result: '' });
        setServerPickerEntry(null);
      }}
    />
  );
  const toServerItem = (server: any): CardPickerItem => ({ key: server.name, content: renderServerCard(server), searchText: server.name });
  const serverItems = serverPicker.items.map(toServerItem);
  const serverGroups: CardGroup<CardPickerItem>[] | null = serverPicker.groups
    ? serverPicker.groups.map((group) => ({ ...group, items: group.items.map(toServerItem) }))
    : null;

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth="lg"
        fullWidth
        PaperProps={{ sx: { height: { xs: '100dvh', sm: '92vh' }, maxHeight: { xs: '100dvh', sm: '92vh' }, borderRadius: { xs: 0, sm: 3 } } }}
      >
        <DialogHeaderActions title={t('flows.static.title')} onClose={onClose} />
        <Divider />
        <DialogContent sx={{ p: { xs: 1.5, sm: 3 }, bgcolor: 'background.default' }}>
          <Stack spacing={2.5}>
            <Paper
              variant="outlined"
              sx={{
                p: { xs: 2, sm: 2.5 },
                borderRadius: 3,
                overflow: 'hidden',
                position: 'relative',
                background: (theme) => `linear-gradient(120deg, ${alpha(theme.palette.info.main, 0.14)}, ${alpha(theme.palette.secondary.main, 0.08)} 58%, transparent)`,
              }}
            >
              <Stack direction="row" spacing={2} alignItems="center">
                <Avatar sx={{ width: 48, height: 48, bgcolor: 'info.main' }}><AutoAwesomeRoundedIcon /></Avatar>
                <Box>
                  <Typography variant="h6" fontWeight={800}>{t('flows.static.heroTitle')}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t('flows.static.heroHelp')}
                  </Typography>
                </Box>
              </Stack>
            </Paper>

            <Accordion defaultExpanded={false} sx={{ borderRadius: '12px !important', '&:before': { display: 'none' } }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1.25} alignItems="center">
                  <SettingsRoundedIcon color="action" />
                  <Box>
                    <Typography fontWeight={700}>{t('flows.static.nodeSettings')}</Typography>
                    <Typography variant="caption" color="text.secondary">{t('flows.static.nodeSettingsHelp')}</Typography>
                  </Box>
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={2}>
                  <TextField
                    label={t('flows.static.name')}
                    value={nodeData.properties?.name ?? nodeData.label ?? ''}
                    onChange={(event) => setNodeData((previous) => previous ? {
                      ...previous,
                      label: event.target.value,
                      properties: { ...previous.properties, name: event.target.value },
                    } : previous)}
                    fullWidth
                  />
                  <Box>
                    <FormControlLabel
                      control={<Switch checked={nodeData.properties?.injectOnce === true} onChange={(event) => setNodeData((previous) => previous ? {
                        ...previous,
                        properties: { ...previous.properties, injectOnce: event.target.checked },
                      } : previous)} />}
                      label={t('flows.static.injectOnce')}
                    />
                    <FormHelperText>{t('flows.static.injectOnce.help')}</FormHelperText>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>

            <Box>
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} gap={1.5} sx={{ mb: 1.5 }}>
                <Box>
                  <Typography variant="h6" fontWeight={800}>{t('flows.static.entriesTitle')}</Typography>
                  <Typography variant="body2" color="text.secondary">{t('flows.static.entriesHelp')}</Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button startIcon={<ForumRoundedIcon />} variant="outlined" onClick={() => appendEntry({ kind: 'message', role: 'user', content: '', attachments: [] })} sx={{ textTransform: 'none' }}>
                    {t('flows.static.addMessage')}
                  </Button>
                  <Button startIcon={<BuildRoundedIcon />} variant="contained" onClick={() => appendEntry({ kind: 'toolCall', executionMode: 'mock', serverName: '', toolName: '', argumentsJson: '{}', result: '' })} sx={{ textTransform: 'none' }}>
                    {t('flows.static.addToolCall')}
                  </Button>
                </Stack>
              </Stack>

              {entries.length === 0 ? (
                <Paper variant="outlined" sx={{ py: 6, px: 2, textAlign: 'center', borderStyle: 'dashed', borderRadius: 3 }}>
                  <AutoAwesomeRoundedIcon color="disabled" sx={{ fontSize: 42 }} />
                  <Typography fontWeight={700} sx={{ mt: 1 }}>{t('flows.static.empty')}</Typography>
                  <Typography variant="body2" color="text.secondary">{t('flows.static.executionOrder')}</Typography>
                </Paper>
              ) : (
                <Stack spacing={1.25}>
                  {entries.map((entry, index) => {
                    const isExpanded = expandedEntries.has(index);
                    const mode = entry.kind === 'toolCall' && entry.executionMode === 'real'
                      ? t('flows.static.realLabel')
                      : t('flows.static.mockLabel');
                    const title = entry.kind === 'message'
                      ? t('flows.static.messageTitle', { role: t(roleTranslationKey[entry.role]) })
                      : `${t('flows.static.toolCallTitle', { mode })}${entry.toolName ? ` · ${entry.toolName}` : ''}`;
                    return (
                      <Accordion
                        key={index}
                        expanded={isExpanded}
                        onChange={(_, expanded) => setExpandedEntries((current) => {
                          const next = new Set(current);
                          if (expanded) next.add(index); else next.delete(index);
                          return next;
                        })}
                        sx={{
                          borderRadius: '12px !important',
                          border: 1,
                          borderColor: entry.kind === 'toolCall' ? 'info.light' : 'divider',
                          '&:before': { display: 'none' },
                          overflow: 'hidden',
                        }}
                      >
                        <Stack direction="row" alignItems="center">
                          <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ pl: 2, pr: 1, flex: 1, minWidth: 0 }}>
                            <Stack direction="row" alignItems="center" spacing={1.25} sx={{ width: '100%', minWidth: 0 }}>
                              <Avatar sx={{ width: 30, height: 30, bgcolor: entry.kind === 'toolCall' ? 'info.main' : roleMeta[entry.role].color }}>
                                {entry.kind === 'toolCall' ? <BuildRoundedIcon sx={{ fontSize: 17 }} /> : roleMeta[entry.role].icon}
                              </Avatar>
                              <Chip size="small" label={index + 1} />
                              <Typography fontWeight={700} noWrap sx={{ flex: 1 }}>{title}</Typography>
                              {entry.kind === 'toolCall' && entry.serverName && <Chip size="small" variant="outlined" label={entry.serverName} />}
                            </Stack>
                          </AccordionSummary>
                          <Stack direction="row" sx={{ pr: 1 }}>
                            <IconButton size="small" aria-label={t('flows.static.moveUp')} onClick={() => moveEntry(index, -1)} disabled={index === 0}><ArrowUpwardIcon fontSize="small" /></IconButton>
                            <IconButton size="small" aria-label={t('flows.static.moveDown')} onClick={() => moveEntry(index, 1)} disabled={index === entries.length - 1}><ArrowDownwardIcon fontSize="small" /></IconButton>
                            <IconButton size="small" color="error" aria-label={t('flows.static.remove')} onClick={() => removeEntry(index)}><DeleteIcon fontSize="small" /></IconButton>
                          </Stack>
                        </Stack>
                        <AccordionDetails sx={{ p: { xs: 1.5, sm: 2.5 }, pt: 0.5 }}>
                          {entry.kind === 'message' ? (
                            <MessageComposer
                              entry={entry}
                              globalNames={globalNames}
                              suggestions={toolReferenceSuggestions}
                              onChange={(patch) => updateEntry(index, patch)}
                            />
                          ) : (
                            <ToolCallEditor entry={entry} onChange={(patch) => updateEntry(index, patch)} onChooseServer={() => setServerPickerEntry(index)} />
                          )}
                        </AccordionDetails>
                      </Accordion>
                    );
                  })}
                </Stack>
              )}
            </Box>

            {cannotSave && (
              <Alert severity="error">
                {t('flows.static.validationError')}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <Divider />
        <DialogActions sx={{ px: { xs: 1.5, sm: 3 }, py: 1.5 }}>
          <Button onClick={onClose}>{t('flows.modal.cancel')}</Button>
          <Button onClick={() => onSave(node.id, { ...nodeData, properties: { ...nodeData.properties, entries } })} variant="contained" disabled={cannotSave}>
            {t('flows.modal.save')}
          </Button>
        </DialogActions>
      </Dialog>

      <CardPickerDialog
        open={serverPickerEntry !== null}
        onClose={() => setServerPickerEntry(null)}
        title={t('flows.static.chooseServer')}
        description={t('flows.static.serverPickerHelp')}
        maxWidth="md"
        isLoading={loadingServers}
        error={loadError}
        searchable
        searchPlaceholder={t('flows.static.searchServers')}
        searchTerm={serverPicker.searchTerm}
        onSearchChange={serverPicker.setSearchTerm}
        columns={{ xs: 12, sm: 6 }}
        items={serverItems}
        groups={serverGroups}
        collapsedKeys={serverPicker.collapsedKeys}
        onToggleGroup={serverPicker.toggleGroup}
      />
    </>
  );
};

export default StaticNodePropertiesModal;
