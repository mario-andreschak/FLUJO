import React, { RefObject } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  IconButton,
  Tooltip
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/flow/FlowBuilder/Modals/ProcessNodePropertiesModal/ServerTools');
import { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';

interface ServerToolsProps {
  isLoadingServers: boolean;
  connectedServers: any[];
  serverToolsMap: Record<string, any[]>;
  serverStatuses: Record<string, string>;
  isLoadingTools: Record<string, boolean>;
  handleSelectToolServer: (serverName: string) => void;
  handleInsertToolBinding: (serverName: string, toolName: string) => void;
  selectedToolServer: string | null;
  isLoadingSelectedServerTools: boolean;
  promptBuilderRef: RefObject<PromptBuilderRef | null>;
  handleRetryServer?: (serverName: string) => Promise<boolean>;
  handleRestartServer?: (serverName: string) => Promise<boolean>;
}

const ServerTools: React.FC<ServerToolsProps> = ({
  isLoadingServers,
  connectedServers,
  serverToolsMap,
  serverStatuses,
  isLoadingTools,
  handleSelectToolServer,
  handleInsertToolBinding,
  selectedToolServer,
  isLoadingSelectedServerTools,
  promptBuilderRef,
  handleRetryServer,
  handleRestartServer
}) => {
  return (
    <Box sx={{ mt: 4 }}>
      <Typography variant="subtitle1" gutterBottom>
        Connected MCP Servers and Tools
      </Typography>

      {isLoadingServers ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={20} />
          <Typography color="text.secondary">Loading servers...</Typography>
        </Box>
      ) : connectedServers.length === 0 ? (
        <Box sx={{ p: 2, border: '1px dashed rgba(0, 0, 0, 0.12)', borderRadius: 1 }}>
          <Typography color="text.secondary" align="center">
            No MCP servers connected to this node.
          </Typography>
          <Typography variant="caption" color="text.secondary" align="center" display="block" sx={{ mt: 1 }}>
            Connect MCP nodes to this Process node to access their tools.
            <br />
            Use the left or right handles of this Process node to create MCP connections.
          </Typography>
        </Box>
      ) : (
        <Box sx={{ maxHeight: '300px', overflow: 'auto', border: '1px solid rgba(0, 0, 0, 0.12)', borderRadius: 1, p: 1 }}>
          {connectedServers.map((server: any) => (
            <Accordion key={server.name} disableGutters sx={{ mb: 1, '&:before': { display: 'none' } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon />}
                  sx={{
                    minHeight: 48,
                    flexGrow: 1,
                    '& .MuiAccordionSummary-content': { 
                      margin: '8px 0',
                      display: 'flex',
                      alignItems: 'center'
                    }
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <Typography
                      variant="subtitle2"
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        color: server.status === 'connected' ? 'success.main' :
                          server.status === 'error' ? 'error.main' : 'text.secondary'
                      }}
                    >
                      {server.name}
                      <Typography variant="caption" sx={{ ml: 1 }}>
                        ({server.status || 'unknown'})
                      </Typography>
                    </Typography>
                  </Box>
                </AccordionSummary>
                
                {/* Action buttons moved outside AccordionSummary */}
                <Box sx={{ display: 'flex', mr: 2 }}>
                  <Tooltip title="Retry connection">
                    <IconButton 
                      size="small" 
                      onClick={(e) => {
                        e.stopPropagation();
                        log.debug(`Retry button clicked for server: ${server.name}`);
                        if (handleRetryServer) {
                          handleRetryServer(server.name);
                        }
                      }}
                      disabled={isLoadingTools[server.name]}
                    >
                      {isLoadingTools[server.name] ? (
                        <CircularProgress size={16} />
                      ) : (
                        <RefreshIcon fontSize="small" />
                      )}
                    </IconButton>
                  </Tooltip>
                  
                  {server.status === 'connected' && (
                    <Tooltip title="Restart server">
                      <IconButton 
                        size="small" 
                        onClick={(e) => {
                          e.stopPropagation();
                          log.debug(`Restart button clicked for server: ${server.name}`);
                          if (handleRestartServer) {
                            handleRestartServer(server.name);
                          }
                        }}
                        disabled={isLoadingTools[server.name]}
                        sx={{ ml: 1 }}
                      >
                        <RestartAltIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              </Box>
              <AccordionDetails sx={{ p: 1, pt: 0 }}>
                {server.status === 'connected' ? (
                  (isLoadingTools[server.name] === true) ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, ml: 2 }}>
                      <CircularProgress size={16} />
                      <Typography variant="body2" color="text.secondary">
                        Loading tools...
                      </Typography>
                    </Box>
                  ) : serverToolsMap[server.name]?.length > 0 ? (
                    <Box sx={{ ml: 2 }}>
                      {serverToolsMap[server.name].map((tool) => (
                        <Box
                          key={tool.name}
                          sx={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            p: 0.5,
                            '&:hover': { bgcolor: 'action.hover', borderRadius: 1 }
                          }}
                        >
                          <Box sx={{ flexGrow: 1, mr: 1 }}>
                            <Typography variant="body2" sx={{ fontWeight: 'medium' }}>
                              {tool.name}
                            </Typography>
                            {tool.description && (
                              <Typography variant="caption" color="text.secondary" display="block">
                                {tool.description}
                              </Typography>
                            )}
                          </Box>
                          <Tooltip title={`Add ${tool.name} to prompt`}>
                            <IconButton
                              size="small"
                              onClick={() => {
                                // First insert the binding
                                handleInsertToolBinding(server.name, tool.name);

                                // Then select the server if needed
                                if (server.name !== selectedToolServer) {
                                  handleSelectToolServer(server.name);
                                }
                              }}
                              sx={{ mt: 0.5 }}
                            >
                              <AddIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      ))}
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ ml: 2 }}>
                      No tools available for this server
                    </Typography>
                  )
                ) : (
                  <Typography variant="body2" color="text.secondary" sx={{ ml: 2 }}>
                    Connect to server to view tools
                  </Typography>
                )}
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default ServerTools;
