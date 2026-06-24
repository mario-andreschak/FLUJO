import React, { RefObject, useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  List,
  TextField,
  InputAdornment,
  Paper,
  Card,
  CardContent,
  Tabs,
  Tab,
  Chip,
  Alert,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import DescriptionIcon from '@mui/icons-material/Description';
import { createLogger } from '@/utils/logger';
import { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';
import { mcpService } from '@/frontend/services/mcp';
import { MCPResource, MCPResourceTemplate } from '@/shared/types/mcp';

const log = createLogger('frontend/components/flow/FlowBuilder/Modals/ProcessNodePropertiesModal/ServerResources');

interface ConnectedMcpNode {
  nodeId: string;
  serverName: string;
  status: string;
  enabledTools: string[];
}

interface ServerResourcesProps {
  connectedMcpNodes: ConnectedMcpNode[];
  // Insert a resource pill for (serverName, uri) into the prompt.
  handleInsertResourceBinding: (serverName: string, uri: string) => void;
  promptBuilderRef: RefObject<PromptBuilderRef | null>;
}

/**
 * "Give this step access to…" — browse the resources published by the MCP servers wired
 * into this Process node and insert a resource pill (rendered into the prompt as content
 * at run time). Self-contained: fetches resources directly from the MCP service, so it
 * needs no extra data plumbing from the modal.
 */
const ServerResources: React.FC<ServerResourcesProps> = ({
  connectedMcpNodes,
  handleInsertResourceBinding,
  promptBuilderRef,
}) => {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [resources, setResources] = useState<MCPResource[]>([]);
  const [templates, setTemplates] = useState<MCPResourceTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [searchQuery, setSearchQuery] = useState('');

  const selectedNode = connectedMcpNodes.find((n) => n.nodeId === selectedNodeId);
  const selectedServer = selectedNode?.serverName;

  // Auto-select the first connected node.
  useEffect(() => {
    if (connectedMcpNodes.length > 0 && !selectedNodeId) {
      setSelectedNodeId(connectedMcpNodes[0].nodeId);
    }
  }, [connectedMcpNodes, selectedNodeId]);

  const load = useCallback(async (serverName: string) => {
    setIsLoading(true);
    setError(undefined);
    try {
      const result = await mcpService.listServerResources(serverName);
      setResources(result.resources || []);
      setTemplates(result.resourceTemplates || []);
      setError(result.error);
    } catch (e) {
      log.warn(`Failed to load resources for ${serverName}`, e);
      setError(e instanceof Error ? e.message : 'Failed to load resources');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedServer) {
      load(selectedServer);
    } else {
      setResources([]);
      setTemplates([]);
    }
  }, [selectedServer, load]);

  const matchesQuery = (text: string) => text.toLowerCase().includes(searchQuery.toLowerCase().trim());
  const filteredResources = searchQuery.trim()
    ? resources.filter((r) => matchesQuery(r.name || '') || matchesQuery(r.uri) || matchesQuery(r.description || ''))
    : resources;
  const filteredTemplates = searchQuery.trim()
    ? templates.filter((t) => matchesQuery(t.name || '') || matchesQuery(t.uriTemplate) || matchesQuery(t.description || ''))
    : templates;

  const insert = (uri: string) => {
    if (selectedServer && uri) {
      handleInsertResourceBinding(selectedServer, uri);
    }
  };

  return (
    <Box sx={{ mt: 4, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Typography variant="subtitle1" gutterBottom>
        Give this step access to…
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 1 }}>
        Pick a resource to insert. Its contents are read and placed into the prompt each time the step runs.
      </Typography>

      {connectedMcpNodes.length === 0 ? (
        <Box sx={{ p: 2, border: '1px dashed rgba(0, 0, 0, 0.12)', borderRadius: 1 }}>
          <Typography color="text.secondary" align="center">
            No MCP nodes connected to this Process node.
          </Typography>
          <Typography variant="caption" color="text.secondary" align="center" display="block" sx={{ mt: 1 }}>
            Connect MCP nodes using the side handles to access their resources.
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, height: 'calc(100% - 40px)' }}>
          <Tabs
            value={selectedNodeId || connectedMcpNodes[0]?.nodeId || ''}
            onChange={(_, value) => setSelectedNodeId(value)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
          >
            {connectedMcpNodes.map((mcpNode) => (
              <Tab
                key={mcpNode.nodeId}
                value={mcpNode.nodeId}
                label={
                  <Typography
                    variant="body2"
                    sx={{
                      color:
                        mcpNode.status === 'connected'
                          ? 'success.main'
                          : mcpNode.status === 'error'
                            ? 'error.main'
                            : 'text.secondary',
                    }}
                  >
                    {mcpNode.serverName}
                  </Typography>
                }
                sx={{ textTransform: 'none', minHeight: 48, opacity: mcpNode.status !== 'connected' ? 0.7 : 1 }}
              />
            ))}
          </Tabs>

          <TextField
            placeholder="Search resources…"
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

          {error && <Alert severity="warning" sx={{ mb: 2 }}>{error}</Alert>}

          <Paper variant="outlined" sx={{ flexGrow: 1, overflow: 'auto', p: 0, height: 'calc(100% - 140px)' }}>
            {selectedNode && selectedNode.status !== 'connected' ? (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography color="text.secondary">
                  Server &apos;{selectedServer}&apos; is not connected. Connect to view resources.
                </Typography>
              </Box>
            ) : isLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                <CircularProgress size={24} />
              </Box>
            ) : filteredResources.length === 0 && filteredTemplates.length === 0 ? (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography color="text.secondary">
                  {searchQuery.trim()
                    ? `No resources match "${searchQuery}".`
                    : 'This server does not publish any resources.'}
                </Typography>
              </Box>
            ) : (
              <List disablePadding>
                {filteredResources.map((r) => (
                  <ResourceCard
                    key={r.uri}
                    primary={r.name || r.uri}
                    secondary={r.description || r.uri}
                    chip={r.mimeType}
                    tooltip={`Add ${r.name || r.uri} to prompt`}
                    onClick={() => insert(r.uri)}
                  />
                ))}
                {filteredTemplates.map((t) => (
                  <ResourceCard
                    key={t.uriTemplate}
                    primary={t.name || t.uriTemplate}
                    secondary={t.description || t.uriTemplate}
                    chip="template"
                    tooltip={`Add template ${t.uriTemplate} to prompt (fill in variables, e.g. with \${global:VAR})`}
                    onClick={() => insert(t.uriTemplate)}
                  />
                ))}
              </List>
            )}
          </Paper>
        </Box>
      )}
    </Box>
  );
};

const ResourceCard: React.FC<{
  primary: string;
  secondary: string;
  chip?: string;
  tooltip: string;
  onClick: () => void;
}> = ({ primary, secondary, chip, onClick }) => (
  <Card
    variant="outlined"
    onClick={onClick}
    sx={{
      mb: 1,
      mx: 1,
      mt: 1,
      cursor: 'pointer',
      '&:hover': { boxShadow: 1, bgcolor: 'action.hover' },
    }}
  >
    <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Box sx={{ width: '100%' }}>
          <Typography variant="subtitle2" component="div" sx={{ display: 'flex', alignItems: 'center' }}>
            <DescriptionIcon fontSize="small" sx={{ mr: 1, color: 'primary.main' }} />
            {primary}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, wordBreak: 'break-all' }}>
            {secondary}
          </Typography>
        </Box>
        {chip && <Chip size="small" label={chip} sx={{ ml: 1, flexShrink: 0 }} />}
      </Box>
    </CardContent>
  </Card>
);

export default ServerResources;
