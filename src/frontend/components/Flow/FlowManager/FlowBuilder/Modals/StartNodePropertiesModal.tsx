"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
  Divider,
} from '@mui/material';
import { FlowNode } from '@/frontend/types/flow/flow';
import PromptBuilder from '@/frontend/components/shared/PromptBuilder';
import { useI18n } from '@/frontend/contexts/I18nContext';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';

interface StartNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: FlowNode['data']) => void;
}

export const StartNodePropertiesModal = ({ open, node, onClose, onSave }: StartNodePropertiesModalProps) => {
  const { t } = useI18n();
  // Clone node data to avoid direct mutation
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, unknown>;
  } | null>(null);
  
  const [promptTemplate, setPromptTemplate] = useState('');

  useEffect(() => {
    if (node) {
      setNodeData({
        ...node.data,
        properties: { ...node.data.properties }
      });
      
      // Load the prompt template from the node's properties
      const savedPromptTemplate = typeof node.data.properties?.promptTemplate === 'string'
        ? node.data.properties.promptTemplate
        : '';
      setPromptTemplate(savedPromptTemplate);
    }
  }, [node, open]);

  const handleSave = () => {
    if (node && nodeData) {
      // Make sure to include the prompt template in the saved data
      const updatedNodeData = {
        ...nodeData,
        properties: {
          ...nodeData.properties,
          promptTemplate: promptTemplate,
        }
      };
      onSave(node.id, updatedNodeData);
      onClose();
    }
  };
  
  const handlePromptChange = (value: string) => {
    setPromptTemplate(value);
    // Also update the node data
    setNodeData((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        properties: {
          ...prev.properties,
          promptTemplate: value,
        },
      };
    });
  };

  if (!node || !nodeData) return null;

  return (
    <Dialog 
      open={open} 
      onClose={onClose}
      maxWidth="xl" 
      fullWidth
      PaperProps={{
        sx: {
          borderTop: 5, 
          borderColor: 'primary.main',
          width: '95vw',
          height: '90vh',
          maxWidth: '95vw',
          maxHeight: '90vh',
        }
      }}
    >
      <DialogHeaderActions
        title={t('flows.modal.properties', { name: nodeData.label || t('flows.modal.startNode') })}
        onClose={onClose}
      />
      
      <Divider />
      
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', p: 3, overflow: 'auto', height: 'calc(90vh - 130px)' }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Typography variant="h6" gutterBottom>
            {t('flows.modal.promptTemplate')}
          </Typography>
          <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', height: 'calc(100% - 40px)' }}>
            <PromptBuilder 
              value={promptTemplate} 
              onChange={handlePromptChange}
              label=""
              height="100%"
            />
          </Box>
        </Box>
      </DialogContent>
      
      <DialogActions>
        <Button onClick={onClose}>{t('flows.modal.cancel')}</Button>
        <Button onClick={handleSave} variant="contained" color="primary">
          {t('flows.modal.saveChanges')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default StartNodePropertiesModal;
