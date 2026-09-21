'use client';

import React, { useMemo } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Checkbox,
  FormControlLabel,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { MCPToolParameterPresets, MCPToolResponse } from '@/shared/types/mcp';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useI18n } from '@/frontend/contexts/I18nContext';
import GlobalReferenceEditor from '@/frontend/components/shared/GlobalReferenceEditor';
import { coercePresetEditorValue, presetEditorValue } from '@/utils/shared/toolParameterPresets';

interface ToolParameterPresetsEditorProps {
  tools: MCPToolResponse[];
  value?: MCPToolParameterPresets;
  onChange: (value: MCPToolParameterPresets) => void;
  title?: string;
  description?: string;
  workspaceRoots?: string[];
}

function propertiesOf(tool: MCPToolResponse): Record<string, Record<string, unknown>> {
  const properties = (tool.inputSchema as { properties?: unknown } | undefined)?.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties as Record<string, Record<string, unknown>>
    : {};
}

export default function ToolParameterPresetsEditor({
  tools,
  value = {},
  onChange,
  title,
  description,
  workspaceRoots,
}: ToolParameterPresetsEditorProps) {
  const { globalEnvVars } = useStorage();
  const { t, tp } = useI18n();
  const globalNames = useMemo(() => Object.keys(globalEnvVars).sort((a, b) => a.localeCompare(b)), [globalEnvVars]);
  const configurableTools = useMemo(
    () => tools.filter((tool) => Object.keys(propertiesOf(tool)).length > 0),
    [tools],
  );

  const setParameter = (toolName: string, parameter: string, next: unknown | undefined, enabled: boolean) => {
    const toolValues = { ...(value[toolName] ?? {}) };
    if (enabled) toolValues[parameter] = next ?? '';
    else delete toolValues[parameter];
    const output = { ...value };
    if (Object.keys(toolValues).length > 0) output[toolName] = toolValues;
    else delete output[toolName];
    onChange(output);
  };

  return (
    <Box>
      <Typography variant="subtitle1" component="h3" fontWeight={700}>{title ?? t('mcp.presets.title')}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
        {description ?? t('mcp.presets.description')}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        {t('mcp.presets.references', { globalReference: '${global:NAME}' })}
      </Typography>

      {configurableTools.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{t('mcp.presets.empty')}</Typography>
      ) : configurableTools.map((tool) => {
        const properties = propertiesOf(tool);
        const presetCount = Object.keys(value[tool.name] ?? {}).length;
        return (
          <Accordion key={tool.name} disableGutters variant="outlined" slots={{ heading: 'h4' }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle2" component="span" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                  {t('mcp.presets.toolTitle', { tool: tool.title || tool.name })}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {presetCount > 0
                    ? tp('mcp.presets.count', presetCount)
                    : t('mcp.presets.configure')}
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={2}>
                {Object.entries(properties).map(([parameter, schema]) => {
                  const enabled = Object.prototype.hasOwnProperty.call(value[tool.name] ?? {}, parameter);
                  const stored = value[tool.name]?.[parameter];
                  const schemaType = typeof schema.type === 'string' ? schema.type : 'unknown';
                  const schemaDescription = typeof schema.description === 'string' ? schema.description : undefined;
                  return (
                    <Box key={parameter} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '180px minmax(0, 1fr)' }, gap: 1, alignItems: 'start' }}>
                      <FormControlLabel
                        control={<Checkbox checked={enabled} onChange={(event) => setParameter(tool.name, parameter, '', event.target.checked)} />}
                        label={(
                          <Box>
                            <Typography variant="body2" fontFamily="monospace">{parameter}</Typography>
                            <Typography variant="caption" color="text.secondary">{schemaType}</Typography>
                          </Box>
                        )}
                      />
                      <Box>
                        <GlobalReferenceEditor
                          value={enabled ? presetEditorValue(stored) : ''}
                          onChange={(next) => setParameter(tool.name, parameter, coercePresetEditorValue(next, schema), true)}
                          globalNames={globalNames}
                          enhancedHitlist
                          workspaceRoots={workspaceRoots}
                          multiline={false}
                          disabled={!enabled}
                          placeholder={t('mcp.presets.placeholder', { globalReference: '${global:NAME}' })}
                          ariaLabel={t('mcp.presets.valueLabel', { tool: tool.name, parameter })}
                        />
                        {schemaDescription && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            {schemaDescription}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  );
                })}
              </Stack>
            </AccordionDetails>
          </Accordion>
        );
      })}
    </Box>
  );
}
