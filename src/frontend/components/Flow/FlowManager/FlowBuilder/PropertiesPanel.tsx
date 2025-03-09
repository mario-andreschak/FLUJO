"use client";

import React from 'react';
import { styled } from '@mui/material/styles';
import {
  Paper,
  Typography,
  TextField,
  Box,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Switch,
  FormControlLabel,
} from '@mui/material';
import { FlowNode } from '@/frontend/types/flow/flow';

const PanelContainer = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(2),
  width: '300px',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: theme.spacing(2),
  overflowY: 'auto',
}));

interface PropertiesPanelProps {
  selectedNode: FlowNode | null;
  onNodeUpdate: (nodeId: string, data: any) => void;
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

export const PropertiesPanel = ({ selectedNode, onNodeUpdate }: PropertiesPanelProps) => {
  if (!selectedNode) {
    return (
      <PanelContainer elevation={2}>
        <Typography variant="body1" color="textSecondary">
          Select a node to view its properties
        </Typography>
      </PanelContainer>
    );
  }

  const properties = getNodeProperties(selectedNode.data.type);

  const handlePropertyChange = (key: string, value: any) => {
    onNodeUpdate(selectedNode.id, {
      ...selectedNode.data,
      properties: {
        ...selectedNode.data.properties,
        [key]: value,
      },
    });
  };

  const renderField = (property: any) => {
    const value = selectedNode.data.properties?.[property.key] ?? '';

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
          />
        );
      case 'select':
        return (
          <FormControl key={property.key} fullWidth>
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
          />
        );
      default:
        return null;
    }
  };

  return (
    <PanelContainer elevation={2}>
      <Typography variant="h6" gutterBottom>
        {selectedNode.data.label} Properties
      </Typography>
      <Box display="flex" flexDirection="column" gap={2}>
        {properties.map((property) => renderField(property))}
      </Box>
    </PanelContainer>
  );
};

export default PropertiesPanel;
