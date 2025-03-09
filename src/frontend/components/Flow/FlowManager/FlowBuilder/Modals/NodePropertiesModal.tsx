"use client";

import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Switch,
  FormControlLabel,
  Typography,
  Box,
  IconButton,
  Divider,
  Tabs,
  Tab,
} from '@mui/material';
import PromptBuilder from '@/frontend/components/shared/PromptBuilder';
import CloseIcon from '@mui/icons-material/Close';
import { FlowNode } from '@/frontend/types/flow/flow';

interface NodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
}

const getNodeProperties = (nodeType: string) => {
  switch (nodeType) {
    case 'start':
      return [
        { key: 'prompt', label: 'Prompt', type: 'text', multiline: true },
        { key: 'systemMessage', label: 'System Message', type: 'text', multiline: true },
        { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 1, step: 0.1 },
      ];
    case 'process':
      return [
        { key: 'operation', label: 'Operation', type: 'select', options: ['transform', 'filter', 'aggregate'] },
        { key: 'enabled', label: 'Enabled', type: 'boolean' },
      ];
    case 'finish':
      return [
        { key: 'format', label: 'Format', type: 'select', options: ['text', 'json', 'markdown'] },
        { key: 'template', label: 'Template', type: 'text', multiline: true },
      ];
    case 'mcp':
      return [
        { key: 'channels', label: 'Channels', type: 'number', min: 1, max: 10, step: 1 },
        { key: 'mode', label: 'Mode', type: 'select', options: ['serial', 'parallel', 'conditional'] },
      ];
    default:
      return [];
  }
};

export const NodePropertiesModal = ({ open, node, onClose, onSave }: NodePropertiesModalProps) => {
  // Clone node data to avoid direct mutation
  const [nodeData, setNodeData] = React.useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);
  
  // Tab state for the modal sections
  const [activeTab, setActiveTab] = useState(0);

  React.useEffect(() => {
    if (node) {
      setNodeData({
        ...node.data,
        properties: { ...node.data.properties }
      });
    }
  }, [node, open]);

  const handlePropertyChange = (key: string, value: any) => {
    setNodeData((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        properties: {
          ...prev.properties,
          [key]: value,
        },
      };
    });
  };

  const handleSave = () => {
    if (node && nodeData) {
      onSave(node.id, nodeData);
      onClose();
    }
  };

  const renderField = (property: any) => {
    if (!nodeData) return null;
    
    const value = nodeData.properties?.[property.key] ?? '';

    switch (property.type) {
      case 'text':
        return (
          <TextField
            key={property.key}
            fullWidth
            label={property.label}
            multiline={property.multiline}
            rows={property.multiline ? 4 : 1}
            value={value}
            onChange={(e) => handlePropertyChange(property.key, e.target.value)}
            margin="normal"
          />
        );
      case 'number':
        return (
          <TextField
            key={property.key}
            fullWidth
            type="number"
            label={property.label}
            value={value}
            inputProps={{
              min: property.min,
              max: property.max,
              step: property.step,
            }}
            onChange={(e) => handlePropertyChange(property.key, Number(e.target.value))}
            margin="normal"
          />
        );
      case 'select':
        return (
          <FormControl key={property.key} fullWidth margin="normal">
            <InputLabel>{property.label}</InputLabel>
            <Select
              value={value || ''}
              label={property.label}
              onChange={(e) => handlePropertyChange(property.key, e.target.value)}
            >
              {property.options.map((option: string) => (
                <MenuItem key={option} value={option}>
                  {option}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        );
      case 'boolean':
        return (
          <FormControlLabel
            key={property.key}
            control={
              <Switch
                checked={value || false}
                onChange={(e) => handlePropertyChange(property.key, e.target.checked)}
              />
            }
            label={property.label}
            sx={{ my: 1 }}
          />
        );
      default:
        return null;
    }
  };

  if (!node || !nodeData) return null;

  const properties = getNodeProperties(node.data.type);
  const nodeTypeLabel = node.data.type.charAt(0).toUpperCase() + node.data.type.slice(1);

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
          height: '90vh',
          maxHeight: '90vh'
        }
      }}
    >
      <DialogTitle>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">
            {nodeData.label || `${nodeTypeLabel} Node`} Properties
          </Typography>
          <IconButton edge="end" color="inherit" onClick={onClose} aria-label="close">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      
      <Divider />
      
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', p: 0, overflow: 'hidden' }}>
        <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Tabs 
            value={activeTab} 
            onChange={(e, newValue) => setActiveTab(newValue)}
            aria-label="node properties tabs"
          >
            <Tab label="Basic Properties" />
            <Tab label="Prompt Builder" />
            <Tab label="Advanced" />
          </Tabs>
        </Box>
        
        <Box sx={{ p: 3, flex: 1, overflow: 'auto' }}>
          {/* Basic Properties Tab */}
          {activeTab === 0 && (
            <>
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
              
              <Box sx={{ mt: 3 }}>
                <Typography variant="subtitle1" gutterBottom>
                  Node Properties
                </Typography>
                {properties.length > 0 ? (
                  properties.map(property => renderField(property))
                ) : (
                  <Typography color="text.secondary">
                    No properties available for this node type.
                  </Typography>
                )}
              </Box>
            </>
          )}
          
          {/* Prompt Builder Tab */}
          {activeTab === 1 && (
            <Box sx={{ mt: 2 }}>
              <PromptBuilder 
                value={nodeData.properties?.prompt || ''}
                onChange={(value) => handlePropertyChange('prompt', value)}
                label="Prompt Template"
              />
              <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
                Use markdown to format your prompt. You can use variables like {'{input}'} that will be replaced at runtime.
              </Typography>
            </Box>
          )}
          
          {/* Advanced Tab */}
          {activeTab === 2 && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="subtitle1" gutterBottom>
                Advanced Properties
              </Typography>
              {/* Add advanced properties here if needed */}
              <Typography color="text.secondary">
                Advanced configuration options will be available in future updates.
              </Typography>
            </Box>
          )}
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

export default NodePropertiesModal;
