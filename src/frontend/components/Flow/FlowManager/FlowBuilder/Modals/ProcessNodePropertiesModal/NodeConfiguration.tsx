import React from 'react';
import { TextField, Typography, Box } from '@mui/material';

interface NodeConfigurationProps {
  nodeData: {
    label: string;
    description?: string;
  } | null;
  setNodeData: (data: any) => void;
}

const NodeConfiguration: React.FC<NodeConfigurationProps> = ({ nodeData, setNodeData }) => {
  if (!nodeData) return null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', pr: 2 }}>
      <Typography variant="h6" gutterBottom>
        Node Configuration
      </Typography>

      <TextField
        fullWidth
        label="Node Label"
        value={nodeData.label || ''}
        onChange={(e) => setNodeData({ ...nodeData, label: e.target.value })}
        margin="normal"
      />

      <TextField
        fullWidth
        label="Description"
        value={nodeData.description || ''}
        onChange={(e) => setNodeData({ ...nodeData, description: e.target.value })}
        margin="normal"
        multiline
        rows={2}
        helperText="This description will be displayed on the node"
      />
    </Box>
  );
};

export default NodeConfiguration;
