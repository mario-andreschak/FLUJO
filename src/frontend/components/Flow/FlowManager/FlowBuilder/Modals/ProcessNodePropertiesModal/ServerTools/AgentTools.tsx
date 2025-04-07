import React, { RefObject, useState, useEffect } from 'react';
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
  List,
  Button,
  Divider
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CodeIcon from '@mui/icons-material/Code';
import { createLogger } from '@/utils/logger';
import { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';

const log = createLogger('frontend/components/flow/FlowBuilder/Modals/ProcessNodePropertiesModal/ServerTools/AgentTools');

// Define the structure for handoff tools
interface HandoffTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

interface AgentToolsProps {
  handoffTools: HandoffTool[];
  isLoadingHandoffTools: boolean;
  handleInsertToolBinding: (toolType: string, toolName: string) => void;
  promptBuilderRef: RefObject<PromptBuilderRef | null>;
  selectedNodeId: string | null;
}

const AgentTools: React.FC<AgentToolsProps> = ({
  handoffTools,
  isLoadingHandoffTools,
  handleInsertToolBinding,
  promptBuilderRef,
  selectedNodeId
}) => {
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
            No parameters required.
          </Typography>
        </Box>
      );
    }

    // If properties exist, display them as before
    return (
      <Box sx={{ mt: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'medium' }}>
          Parameters:
        </Typography>
        <Box sx={{ pl: 1, mt: 0.5 }}>
          {Object.entries(inputSchema.properties).map(([paramName, paramDetails]: [string, any]) => (
            <Box key={paramName} sx={{ mb: 0.5 }}>
              <Typography variant="caption" component="span" sx={{ fontWeight: 'medium' }}>
                {paramName}
                {inputSchema.required?.includes(paramName) &&
                  <Typography variant="caption" component="span" color="error.main"> *</Typography>
                }
                {': '}
              </Typography>
              <Typography variant="caption" component="span" color="text.secondary">
                {paramDetails.description || paramDetails.type || 'No description'}
              </Typography>
              {paramDetails.enum && (
                <Box sx={{ pl: 2, mt: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    Options: {paramDetails.enum.join(', ')}
                  </Typography>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      </Box>
    );
  };

  return (
    <Box sx={{ mt: 4, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Typography variant="subtitle1" gutterBottom>
        Agent Handoff Tools
      </Typography>

      {isLoadingHandoffTools ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={20} />
          <Typography color="text.secondary">Loading handoff tools...</Typography>
        </Box>
      ) : handoffTools.length === 0 ? (
        <Box sx={{ p: 2, border: '1px dashed rgba(0, 0, 0, 0.12)', borderRadius: 1 }}>
          <Typography color="text.secondary" align="center">
            No handoff tools available for this node.
          </Typography>
          <Typography variant="caption" color="text.secondary" align="center" display="block" sx={{ mt: 1 }}>
            Connect this Process node to other nodes to enable handoff tools.
          </Typography>
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
            <Button 
              variant="outlined" 
              size="small"
              onClick={() => {
                // Create a debug handoff tool for testing
                const debugTool: HandoffTool = {
                  name: "debug_handoff_tool",
                  description: "Debug handoff tool for testing",
                  inputSchema: {
                    type: "object",
                    properties: {
                      debug: {
                        type: "boolean",
                        description: "This is a debug tool"
                      }
                    },
                    required: ["debug"]
                  }
                };
                
                // Insert the debug tool
                handleInsertToolBinding('handoff', debugTool.name);
                
                // Log the action
                log.debug('Inserted debug handoff tool', { toolName: debugTool.name });
              }}
            >
              Insert Debug Tool
            </Button>
          </Box>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, height: 'calc(100% - 40px)' }}>
          {/* Search input */}
          <TextField
            placeholder="Search handoff tools..."
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
          
          {/* Debug info */}
          <Box sx={{ mb: 2, p: 2, bgcolor: 'rgba(0, 0, 0, 0.02)', borderRadius: 1 }}>
            <Typography variant="caption" sx={{ fontWeight: 'bold' }}>
              Debug Information:
            </Typography>
            <Typography variant="caption" component="div">
              Node ID: {selectedNodeId || 'None'}
            </Typography>
            <Typography variant="caption" component="div">
              Handoff Tools Count: {handoffTools.length}
            </Typography>
            <Typography variant="caption" component="div">
              Tool Names: {handoffTools.map(t => t.name).join(', ')}
            </Typography>
          </Box>
          
          {/* Tool list */}
          <Paper 
            variant="outlined" 
            sx={{ 
              flexGrow: 1,
              overflow: 'auto', 
              p: 0,
              height: 'calc(100% - 140px)' // Adjusted for debug info
            }}
          >
            {filteredTools.length === 0 ? (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography color="text.secondary">
                  {searchQuery.trim()
                    ? `No handoff tools match "${searchQuery}".`
                    : "No handoff tools available."}
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
                            {tool.description || "No description available"}
                          </Typography>

                          {tool.inputSchema && formatParameterSchema(tool.inputSchema)}
                        </Box>
                      </Box>
                    </CardContent>
                    <Tooltip title={`Add ${tool.name} handoff tool to prompt`}>
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
