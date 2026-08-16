"use client";

import React, { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  IconButton,
  InputAdornment,
  List,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import type { MCPToolResponse } from '@/shared/types/mcp';
import type { MCPToolParameterPresets } from '@/shared/types/mcp';
import ToolParameterPresetsEditor from '@/frontend/components/mcp/ToolParameterPresetsEditor';
import { extractUiResourceUri } from '@/shared/utils/mcpApps';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';
import {
  getMCPToolDisplayName,
  groupMCPTools,
  MCPToolUsesBehaviorDefaults,
  type MCPToolSectionKey,
} from './mcpToolPresentation';

interface MCPNodeToolListProps {
  tools: MCPToolResponse[];
  enabledTools: string[];
  onToggle: (toolName: string) => void;
  onActivateAll: () => void;
  onDeactivateAll: () => void;
  allowedToolsTitle?: string;
  toolsHelp?: string;
  parameterPresets?: MCPToolParameterPresets;
  onParameterPresetsChange?: (value: MCPToolParameterPresets) => void;
  parameterPresetsTitle?: string;
  parameterPresetsDescription?: string;
  workspaceRoots?: string[];
}

const sectionColor: Record<MCPToolSectionKey, 'success' | 'error' | 'warning'> = {
  readOnly: 'success',
  destructive: 'error',
  otherChanges: 'warning',
};

const sectionKeys: Record<MCPToolSectionKey, { title: TranslationKey; help: TranslationKey }> = {
  readOnly: {
    title: 'flows.mcpNode.readOnlyTools',
    help: 'flows.mcpNode.readOnlyToolsHelp',
  },
  destructive: {
    title: 'flows.mcpNode.destructiveTools',
    help: 'flows.mcpNode.destructiveToolsHelp',
  },
  otherChanges: {
    title: 'flows.mcpNode.otherChangeTools',
    help: 'flows.mcpNode.otherChangeToolsHelp',
  },
};

function schemaSummary(schema: MCPToolResponse['inputSchema'] | MCPToolResponse['outputSchema']): string {
  if (!schema || typeof schema !== 'object') return '{}';
  return JSON.stringify(schema, null, 2);
}

const MCPNodeToolList: React.FC<MCPNodeToolListProps> = ({
  tools,
  enabledTools,
  onToggle,
  onActivateAll,
  onDeactivateAll,
  allowedToolsTitle,
  toolsHelp,
  parameterPresets,
  onParameterPresetsChange,
  parameterPresetsTitle,
  parameterPresetsDescription,
  workspaceRoots,
}) => {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const enabledSet = useMemo(() => new Set(enabledTools), [enabledTools]);
  const enabledCount = useMemo(
    () => tools.reduce((count, tool) => count + (enabledSet.has(tool.name) ? 1 : 0), 0),
    [enabledSet, tools],
  );
  const filteredTools = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return tools;
    return tools.filter((tool) => (
      `${getMCPToolDisplayName(tool)} ${tool.name} ${tool.description || ''}`
        .toLocaleLowerCase()
        .includes(query)
    ));
  }, [search, tools]);
  const sections = useMemo(() => groupMCPTools(filteredTools), [filteredTools]);

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box>
          <Typography variant="h6">{allowedToolsTitle ?? t('flows.mcpNode.allowedTools')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {toolsHelp ?? t('flows.mcpNode.toolsHelp')}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Button size="small" variant="outlined" onClick={onActivateAll} disabled={tools.length === 0 || enabledCount === tools.length}>
            {t('flows.mcpNode.activateAll')}
          </Button>
          <Button size="small" variant="outlined" onClick={onDeactivateAll} disabled={enabledSet.size === 0}>
            {t('flows.mcpNode.deactivateAll')}
          </Button>
        </Stack>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2, mb: 1.5 }}>
        <Chip
          size="small"
          color={enabledCount > 0 ? 'primary' : 'default'}
          label={t('flows.mcpNode.enabledCount', { enabled: enabledCount, total: tools.length })}
        />
        <Typography variant="caption" color="text.secondary">
          {t('flows.mcpNode.annotationNotice')}
        </Typography>
      </Box>

      <TextField
        fullWidth
        size="small"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t('flows.mcpNode.searchTools')}
        inputProps={{ 'aria-label': t('flows.mcpNode.searchTools') }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        }}
        sx={{ mb: 2 }}
      />

      {filteredTools.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
          {t('flows.mcpNode.noMatchingTools')}
        </Typography>
      ) : (
        <Stack spacing={3}>
          {sections.map((section) => {
            const copy = sectionKeys[section.key];
            return (
              <Box component="section" key={section.key} aria-labelledby={`mcp-tools-${section.key}`}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <Typography id={`mcp-tools-${section.key}`} variant="subtitle1" fontWeight={700}>
                    {t(copy.title)}
                  </Typography>
                  <Chip size="small" color={sectionColor[section.key]} variant="outlined" label={section.tools.length} />
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  {t(copy.help)}
                </Typography>

                <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {section.tools.map((tool) => {
                    const displayName = getMCPToolDisplayName(tool);
                    const isExpanded = expandedTool === tool.name;
                    const isEnabled = enabledSet.has(tool.name);
                    const isReadOnly = tool.annotations?.readOnlyHint === true;
                    const taskSupport = tool.execution?.taskSupport;
                    const hasInteractiveView = !!extractUiResourceUri(tool._meta);
                    return (
                      <Paper
                        component="li"
                        variant="outlined"
                        key={tool.name}
                        sx={{ listStyle: 'none', overflow: 'hidden', borderColor: isEnabled ? 'primary.main' : 'divider' }}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25, p: 1.5 }}>
                          <Switch
                            size="small"
                            checked={isEnabled}
                            onChange={() => onToggle(tool.name)}
                            inputProps={{ 'aria-label': t('flows.mcpNode.toggleTool', { tool: displayName }) }}
                            sx={{ mt: -0.25 }}
                          />
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>
                              {displayName}
                            </Typography>
                            {tool.description && (
                              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                                {tool.description}
                              </Typography>
                            )}
                            <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75, mt: 1 }}>
                              {MCPToolUsesBehaviorDefaults(tool) && (
                                <Chip size="small" variant="outlined" label={t('flows.mcpNode.cautiousDefaults')} />
                              )}
                              {!isReadOnly && tool.annotations?.idempotentHint === true && (
                                <Chip size="small" variant="outlined" color="success" label={t('flows.mcpNode.safeToRepeat')} />
                              )}
                              {tool.annotations?.openWorldHint === false && (
                                <Chip size="small" variant="outlined" label={t('flows.mcpNode.closedWorld')} />
                              )}
                              {tool.annotations?.openWorldHint === true && (
                                <Chip size="small" variant="outlined" color="warning" label={t('flows.mcpNode.externalAccess')} />
                              )}
                              {taskSupport && taskSupport !== 'forbidden' && (
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  color="info"
                                  label={taskSupport === 'required'
                                    ? t('flows.mcpNode.backgroundRequired')
                                    : t('flows.mcpNode.backgroundOptional')}
                                />
                              )}
                              {tool.outputSchema && (
                                <Chip size="small" variant="outlined" label={t('flows.mcpNode.structuredResult')} />
                              )}
                              {hasInteractiveView && (
                                <Chip size="small" variant="outlined" color="info" label={t('flows.mcpNode.interactiveView')} />
                              )}
                            </Stack>
                          </Box>
                          <Tooltip title={t('flows.inspector.technicalDetails')}>
                            <IconButton
                              size="small"
                              onClick={() => setExpandedTool(isExpanded ? null : tool.name)}
                              aria-expanded={isExpanded}
                              aria-label={t(isExpanded ? 'flows.mcpNode.hideTechnicalDetails' : 'flows.mcpNode.showTechnicalDetails', { tool: displayName })}
                            >
                              {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                            </IconButton>
                          </Tooltip>
                        </Box>
                        <Collapse in={isExpanded} unmountOnExit>
                          <Divider />
                          <Box sx={{ p: 1.5, bgcolor: 'action.hover' }}>
                            <Typography variant="caption" color="text.secondary">
                              {t('flows.mcpNode.programmaticName')}
                            </Typography>
                            <Typography component="code" variant="body2" sx={{ display: 'block', overflowWrap: 'anywhere', mb: 1.5 }}>
                              {tool.name}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {t('flows.mcpNode.inputSchema')}
                            </Typography>
                            <Box component="pre" sx={{ m: 0, mt: 0.5, p: 1, borderRadius: 1, bgcolor: 'background.paper', overflow: 'auto', fontSize: 12 }}>
                              {schemaSummary(tool.inputSchema)}
                            </Box>
                            {tool.outputSchema && (
                              <>
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                                  {t('flows.mcpNode.outputSchema')}
                                </Typography>
                                <Box component="pre" sx={{ m: 0, mt: 0.5, p: 1, borderRadius: 1, bgcolor: 'background.paper', overflow: 'auto', fontSize: 12 }}>
                                  {schemaSummary(tool.outputSchema)}
                                </Box>
                              </>
                            )}
                            {(tool.annotations || tool.execution || tool._meta) && (
                              <>
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                                  {t('flows.mcpNode.protocolMetadata')}
                                </Typography>
                                <Box component="pre" sx={{ m: 0, mt: 0.5, p: 1, borderRadius: 1, bgcolor: 'background.paper', overflow: 'auto', fontSize: 12 }}>
                                  {JSON.stringify({
                                    ...(tool.annotations ? { annotations: tool.annotations } : {}),
                                    ...(tool.execution ? { execution: tool.execution } : {}),
                                    ...(tool._meta ? { _meta: tool._meta } : {}),
                                  }, null, 2)}
                                </Box>
                              </>
                            )}
                          </Box>
                        </Collapse>
                      </Paper>
                    );
                  })}
                </List>
              </Box>
            );
          })}
        </Stack>
      )}
      {onParameterPresetsChange && (
        <>
          <Divider sx={{ my: 3 }} />
          <ToolParameterPresetsEditor
            tools={tools.filter((tool) => enabledSet.has(tool.name))}
            value={parameterPresets}
            onChange={onParameterPresetsChange}
            workspaceRoots={workspaceRoots}
            title={parameterPresetsTitle ?? 'Step-specific tool parameters'}
            description={parameterPresetsDescription ?? 'These values apply only to this MCP node and override matching server-wide values. Fixed parameters are hidden from the model.'}
          />
        </>
      )}
    </Box>
  );
};

export default MCPNodeToolList;
