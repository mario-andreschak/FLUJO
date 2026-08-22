import React, { RefObject, useState } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  TextField,
  InputAdornment,
  Paper,
  Card,
  CardContent,
  Tooltip,
  List
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CodeIcon from '@mui/icons-material/Code';
import { createLogger } from '@/utils/logger';
import { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/flow/FlowBuilder/Modals/ProcessNodePropertiesModal/ServerTools/AgentTools');

// Define the structure for handoff tools
interface HandoffTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

interface AgentToolsProps {
  handoffTools: HandoffTool[];
  isLoadingHandoffTools: boolean;
  handleInsertToolBinding: (toolType: string, toolName: string) => void;
  promptBuilderRef: RefObject<PromptBuilderRef | null>;
}

const AgentTools: React.FC<AgentToolsProps> = ({
  handoffTools,
  isLoadingHandoffTools,
  handleInsertToolBinding,
  promptBuilderRef
}) => {
  const { t, formatList } = useI18n();
  // State to track search query
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Filter tools based on search query
  const filteredTools = handoffTools.filter(tool => {
    if (!searchQuery.trim()) return true;
    
    const query = searchQuery.toLowerCase().trim();
    return (
      (tool.name && tool.name.toLowerCase().includes(query)) ||
      (tool.description && tool.description.toLowerCase().includes(query))
    );
  });

  // Format parameter schema for display
  const formatParameterSchema = (inputSchema: HandoffTool['inputSchema']) => {
    // Check if inputSchema and properties exist and if there are any properties
    if (!inputSchema || !inputSchema.properties || Object.keys(inputSchema.properties).length === 0) {
      // If no properties, display "No parameters"
      return (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
            {t('flows.agentTools.noParameters')}
          </Typography>
        </Box>
      );
    }

    // If properties exist, display them as before
    return (
      <Box sx={{ mt: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'medium' }}>
          {t('flows.agentTools.parameters')}
        </Typography>
        <Box sx={{ pl: 1, mt: 0.5 }}>
          {Object.entries(inputSchema.properties).map(([paramName, paramDetails]) => {
            const details = paramDetails && typeof paramDetails === 'object'
              ? paramDetails as Record<string, unknown>
              : {};
            const description = typeof details.description === 'string' ? details.description : undefined;
            const type = typeof details.type === 'string' ? details.type : undefined;
            const enumValues = Array.isArray(details.enum)
              ? details.enum.filter((value): value is string => typeof value === 'string')
              : [];
            return <Box key={paramName} sx={{ mb: 0.5 }}>
              <Typography variant="caption" component="span" sx={{ fontWeight: 'medium' }}>
                {paramName}
                {inputSchema.required?.includes(paramName) &&
                  <Typography variant="caption" component="span" color="error.main"> *</Typography>
                }
                {': '}
              </Typography>
              <Typography variant="caption" component="span" color="text.secondary">
                {description || type || t('flows.agentTools.noDescription')}
              </Typography>
              {enumValues.length > 0 && (
                <Box sx={{ pl: 2, mt: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    {t('flows.agentTools.options', { options: formatList(enumValues) })}
                  </Typography>
                </Box>
              )}
            </Box>;
          })}
        </Box>
      </Box>
    );
  };

  return (
    <Box sx={{ mt: 4, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Typography variant="subtitle1" gutterBottom>
        {t('flows.agentTools.title')}
      </Typography>

      {isLoadingHandoffTools ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={20} />
          <Typography color="text.secondary">{t('flows.agentTools.loading')}</Typography>
        </Box>
      ) : handoffTools.length === 0 ? (
        <Box sx={{ p: 2, border: '1px dashed rgba(0, 0, 0, 0.12)', borderRadius: 1 }}>
          <Typography color="text.secondary" align="center">
            {t('flows.agentTools.none')}
          </Typography>
          <Typography variant="caption" color="text.secondary" align="center" display="block" sx={{ mt: 1 }}>
            {t('flows.agentTools.connectHelp')}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, height: 'calc(100% - 40px)' }}>
          {/* Search input */}
          <TextField
            placeholder={t('flows.agentTools.search')}
            variant="outlined"
            size="small"
            fullWidth
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            sx={{ mb: 2 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          
          {/* Tool list */}
          <Paper
            variant="outlined"
            sx={{
              flexGrow: 1,
              overflow: 'auto',
              p: 0,
              height: 'calc(100% - 56px)' // Below the search field
            }}
          >
            {filteredTools.length === 0 ? (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography color="text.secondary">
                  {searchQuery.trim()
                    ? t('flows.agentTools.noMatch', { search: searchQuery })
                    : t('flows.agentTools.none')}
                </Typography>
              </Box>
            ) : (
              <List disablePadding>
                {filteredTools.map((tool) => (
                  <Card
                    key={tool.name}
                    variant="outlined"
                    onClick={() => {
                      if (tool.name) {
                        log.debug('Inserting handoff tool binding', {
                          toolType: 'handoff',
                          toolName: tool.name
                        });
                        handleInsertToolBinding('handoff', tool.name);
                      } else {
                        log.warn('Cannot insert handoff tool binding, tool name is undefined', {
                          toolName: tool.name
                        });
                      }
                    }}
                    sx={{
                      mb: 1,
                      mx: 1,
                      mt: 1,
                      cursor: 'pointer',
                      position: 'relative',
                      bgcolor: 'rgba(0, 0, 0, 0.04)', // Light grey background
                      '&:hover': {
                        boxShadow: 1,
                        bgcolor: 'rgba(0, 0, 0, 0.08)' // Slightly darker on hover
                      }
                    }}
                  >
                    <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <Box sx={{ width: '100%' }}>
                          <Typography variant="subtitle2" component="div" sx={{ display: 'flex', alignItems: 'center' }}>
                            <CodeIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
                            {tool.name}
                          </Typography>

                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            {tool.description || t('flows.agentTools.noDescription')}
                          </Typography>

                          {tool.inputSchema && formatParameterSchema(tool.inputSchema)}
                        </Box>
                      </Box>
                    </CardContent>
                    <Tooltip title={t('flows.agentTools.insert', { tool: tool.name })}>
                      <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
                    </Tooltip>
                  </Card>
                ))}
              </List>
            )}
          </Paper>
        </Box>
      )}
    </Box>
  );
};

export default AgentTools;
