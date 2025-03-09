import React from 'react';
import { TextField, FormControl, InputLabel, Select, MenuItem, FormControlLabel, Switch, Typography, Box } from '@mui/material';
import { PropertyDefinition } from './types';

interface NodePropertiesProps {
  nodeData: {
    properties: Record<string, any>;
  } | null;
  handlePropertyChange: (key: string, value: any) => void;
  properties: PropertyDefinition[];
}

const NodeProperties: React.FC<NodePropertiesProps> = ({ nodeData, handlePropertyChange, properties }) => {
  const renderField = (property: PropertyDefinition) => {
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
              {property.options?.map((option: string) => (
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

  return (
    <>
      {properties.length > 0 && (
        <Box sx={{ mt: 3 }}>
          <Typography variant="subtitle1" gutterBottom>
            Node Properties
          </Typography>
          {properties.map(property => renderField(property))}
        </Box>
      )}
    </>
  );
};

export default NodeProperties;
