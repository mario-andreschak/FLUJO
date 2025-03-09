"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
  IconButton,
  Divider,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { FlowNode } from '@/frontend/types/flow/flow';
import PromptBuilder from '@/frontend/components/shared/PromptBuilder';

interface StartNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
}

export const StartNodePropertiesModal = ({ open, node, onClose, onSave }: StartNodePropertiesModalProps) => {
  // Clone node data to avoid direct mutation
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);
  
  const [promptTemplate, setPromptTemplate] = useState('');

  useEffect(() => {
    if (node) {
      setNodeData({
        ...node.data,
        properties: { ...node.data.properties }
      });
      
      // Load the prompt template from the node's properties
      const savedPromptTemplate = node.data.properties?.promptTemplate || '';
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
      <DialogTitle>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">
            {nodeData.label || 'Start Node'} Properties
          </Typography>
          <IconButton edge="end" color="inherit" onClick={onClose} aria-label="close">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      
      <Divider />
      
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', p: 3, overflow: 'auto', height: 'calc(90vh - 130px)' }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Typography variant="h6" gutterBottom>
            Prompt Template
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
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" color="primary">
          Save Changes
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default StartNodePropertiesModal;
