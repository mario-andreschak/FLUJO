import React from 'react';
import { TextField, FormControl, InputLabel, Select, MenuItem, FormControlLabel, Switch, Typography, Box } from '@mui/material';
import { PropertyDefinition } from './types';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface NodePropertiesProps {
  nodeData: {
    properties: Record<string, unknown>;
  } | null;
  handlePropertyChange: (key: string, value: unknown) => void;
  properties: PropertyDefinition[];
}

const NodeProperties: React.FC<NodePropertiesProps> = ({ nodeData, handlePropertyChange, properties }) => {
  const { t } = useI18n();
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
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => handlePropertyChange(property.key, e.target.value)}
            margin="normal"
            helperText={property.helperText}
          />
        );
      case 'number':
        return (
          <TextField
            key={property.key}
            fullWidth
            type="number"
            label={property.label}
            value={typeof value === 'number' || typeof value === 'string' ? value : ''}
            inputProps={{
              min: property.min,
              max: property.max,
              step: property.step,
            }}
            onChange={(e) => {
              // Empty input clears the property (undefined) so it can mean
              // "inherit / unset" rather than 0; otherwise store the number.
              const raw = e.target.value;
              handlePropertyChange(property.key, raw === '' ? undefined : Number(raw));
            }}
            margin="normal"
            helperText={property.helperText}
          />
        );
      case 'select':
        return (
          <FormControl key={property.key} fullWidth margin="normal">
            <InputLabel>{property.label}</InputLabel>
            <Select
              value={typeof value === 'string' || typeof value === 'number' ? value : ''}
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
                checked={typeof value === 'boolean' ? value : false}
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
            {t('flows.nodeProperties.title')}
          </Typography>
          {properties.map(property => renderField(property))}
        </Box>
      )}
    </>
  );
};

export default NodeProperties;
