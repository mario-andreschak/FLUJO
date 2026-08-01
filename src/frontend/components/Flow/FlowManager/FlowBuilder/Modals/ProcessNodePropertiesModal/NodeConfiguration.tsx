import React from 'react';
import { TextField, Typography, Box } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface NodeConfigurationProps {
  nodeData: {
    label: string;
    description?: string;
  } | null;
  setNodeData: (data: any) => void;
}

const NodeConfiguration: React.FC<NodeConfigurationProps> = ({ nodeData, setNodeData }) => {
  const { t } = useI18n();
  if (!nodeData) return null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', pr: 2 }}>
      <Typography variant="h6" gutterBottom>
        {t('flows.process.configTitle')}
      </Typography>

      <TextField
        fullWidth
        label={t('flows.mcpNode.label')}
        value={nodeData.label || ''}
        onChange={(e) =>
          // Editing the label by hand marks it custom so model (re)binding
          // never auto-overwrites it (issue #38, Item C).
          setNodeData((prev: any) => ({
            ...prev,
            label: e.target.value,
            properties: { ...prev?.properties, nameIsCustom: true },
          }))
        }
        margin="normal"
      />

      <TextField
        fullWidth
        label={t('flows.process.description')}
        value={nodeData.description || ''}
        onChange={(e) => setNodeData({ ...nodeData, description: e.target.value })}
        margin="normal"
        multiline
        rows={2}
        helperText={t('flows.process.descriptionHelp')}
      />
    </Box>
  );
};

export default NodeConfiguration;
