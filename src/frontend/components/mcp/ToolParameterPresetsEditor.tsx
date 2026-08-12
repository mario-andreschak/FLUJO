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

function propertiesOf(tool: MCPToolResponse): Record<string, Record<string, any>> {
  const properties = (tool.inputSchema as { properties?: unknown } | undefined)?.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties as Record<string, Record<string, any>>
    : {};
}

export default function ToolParameterPresetsEditor({
  tools,
  value = {},
  onChange,
  title = 'Pre-set tool parameters',
  description = 'Fixed values are removed from the model-visible schema and injected into every call. Node values override server defaults.',
  workspaceRoots,
}: ToolParameterPresetsEditorProps) {
  const { globalEnvVars } = useStorage();
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
      <Typography variant="subtitle1" fontWeight={700}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
        {description}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        Type <code>${'{global:NAME}'}</code> for globals, <code>@</code> for context/entities, or <code>@@</code> to find files in configured workspace roots. Append <code>.name</code>, <code>.created</code>, or <code>.updated</code>; <code>.id</code> is the default.
      </Typography>

      {configurableTools.length === 0 ? (
        <Typography variant="body2" color="text.secondary">No tool parameters are available.</Typography>
      ) : configurableTools.map((tool) => {
        const properties = propertiesOf(tool);
        const presetCount = Object.keys(value[tool.name] ?? {}).length;
        return (
          <Accordion key={tool.name} disableGutters variant="outlined">
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>
                  Fixed parameters for {tool.title || tool.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {presetCount > 0
                    ? `${presetCount} fixed parameter${presetCount === 1 ? '' : 's'}`
                    : 'Configure values hidden from the model'}
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={2}>
                {Object.entries(properties).map(([parameter, schema]) => {
                  const enabled = Object.prototype.hasOwnProperty.call(value[tool.name] ?? {}, parameter);
                  const stored = value[tool.name]?.[parameter];
                  return (
                    <Box key={parameter} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '180px minmax(0, 1fr)' }, gap: 1, alignItems: 'start' }}>
                      <FormControlLabel
                        control={<Checkbox checked={enabled} onChange={(event) => setParameter(tool.name, parameter, '', event.target.checked)} />}
                        label={(
                          <Box>
                            <Typography variant="body2" fontFamily="monospace">{parameter}</Typography>
                            <Typography variant="caption" color="text.secondary">{schema.type || 'any'}</Typography>
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
                          placeholder="Literal, ${global:NAME}, or @reference"
                          ariaLabel={`Fixed value for ${tool.name}.${parameter}`}
                        />
                        {schema.description && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            {schema.description}
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
