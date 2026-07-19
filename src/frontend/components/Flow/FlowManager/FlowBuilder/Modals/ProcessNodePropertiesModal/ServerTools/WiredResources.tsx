import React, { RefObject } from 'react';
import {
  Box,
  Typography,
  List,
  Card,
  CardContent,
  Chip,
  Tooltip,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import SaveAltIcon from '@mui/icons-material/SaveAlt';
import { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';

/**
 * A resource NODE wired to this Process node (Tier 3, issue #161 item 3).
 * Direction encodes role: resource→process = consume; process→resource = produce.
 */
export interface WiredResource {
  id: string;
  role: 'consume' | 'produce';
  label: string;
  scope?: 'mcp' | 'run';
  runName?: string;
  uri?: string;
  boundServer?: string;
}

interface WiredResourcesProps {
  wiredResources: WiredResource[];
  promptBuilderRef: RefObject<PromptBuilderRef | null>;
}

/**
 * Shows the resource NODES connected to this Process node on the canvas — the
 * graph-visible siblings of the MCP resources listed below. Before issue #161
 * the Resources tab only showed MCP-server resources, so a wired resource node
 * (and the artifact a produce node writes) was invisible here. For a run
 * artifact you can insert a `${res:NAME}` reference into the prompt to read it
 * back; produce nodes are written by the step's `write_resource` tool at run time.
 */
const WiredResources: React.FC<WiredResourcesProps> = ({ wiredResources, promptBuilderRef }) => {
  if (wiredResources.length === 0) return null;

  const insertResRef = (runName?: string) => {
    if (runName && promptBuilderRef.current) {
      promptBuilderRef.current.insertText(`\${res:${runName}}`);
    }
  };

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle1" gutterBottom>
        Wired resource nodes
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
        Resource nodes connected to this step on the canvas. A <strong>produce</strong> node is
        written by the step&apos;s <code>write_resource</code> tool; a <strong>consume</strong> node&apos;s
        contents are injected into the prompt when the step runs.
      </Typography>

      <List disablePadding>
        {wiredResources.map((r) => (
          <Card key={`${r.role}-${r.id}`} variant="outlined" sx={{ mb: 1, mt: 1 }}>
            <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <Box sx={{ width: '100%' }}>
                  <Typography variant="subtitle2" component="div" sx={{ display: 'flex', alignItems: 'center' }}>
                    <DescriptionIcon fontSize="small" sx={{ mr: 1, color: 'primary.main' }} />
                    {r.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, wordBreak: 'break-all' }}>
                    {r.scope === 'run'
                      ? `Run artifact${r.runName ? ` "${r.runName}"` : ' (no name set)'}`
                      : `MCP resource${r.uri ? ` ${r.uri}` : ''}${r.boundServer ? ` on ${r.boundServer}` : ''}`}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, ml: 1, gap: 0.5 }}>
                  {r.scope === 'run' && r.runName && (
                    <Tooltip title={`Insert \${res:${r.runName}} into the prompt`}>
                      <Chip
                        size="small"
                        icon={<SaveAltIcon />}
                        label={`\${res:${r.runName}}`}
                        onClick={() => insertResRef(r.runName)}
                        clickable
                        sx={{ maxWidth: 220 }}
                      />
                    </Tooltip>
                  )}
                  <Chip
                    size="small"
                    color={r.role === 'produce' ? 'secondary' : 'default'}
                    label={r.role}
                  />
                </Box>
              </Box>
            </CardContent>
          </Card>
        ))}
      </List>
    </Box>
  );
};

export default WiredResources;
