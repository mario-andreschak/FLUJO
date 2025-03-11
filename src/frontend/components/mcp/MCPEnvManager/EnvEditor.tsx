'use client';

import React, { useState, useEffect } from 'react';
import { 
  Box, 
  Paper, 
  Typography, 
  TextField, 
  Button, 
  IconButton,
  Checkbox,
  FormControlLabel,
  Modal,
  Chip,
  InputAdornment,
  FormHelperText,
  Stack,
  Grid,
  Divider
} from '@mui/material';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp/MCPEnvManager/EnvEditor');
import { useStorage } from '@/frontend/contexts/StorageContext';
import { 
  Link as LinkIcon, 
  Cancel as CancelIcon, 
  LockOutlined as LockIcon,
  Delete as DeleteIcon,
  Add as AddIcon
} from '@mui/icons-material';
import { isSecretEnvVar } from '@/utils/shared';
import { MASKED_STRING } from '@/shared/types/constants';

interface EnvVariable {
  key: string;
  value: string;
  isSecret: boolean;
  isBound?: boolean;
  boundTo?: string;
  isEncrypted?: boolean;
  isValidKey?: boolean;
  showWarning?: boolean; // Flag to show warning when switching from secret to normal
}

interface EnvEditorProps {
  serverName: string;
  initialEnv: Record<string, { value: string, metadata: { isSecret: boolean } } | string>;
  onSave: (env: Record<string, { value: string, metadata: { isSecret: boolean } } | string>) => Promise<void>;
  onDelete?: (key: string) => Promise<void>; // Add this new prop
}

const EnvEditor: React.FC<EnvEditorProps> = ({
  serverName,
  initialEnv,
  onSave,
  onDelete,
}) => {
  const { globalEnvVars } = useStorage();
  const [variables, setVariables] = useState<EnvVariable[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showBindModal, setShowBindModal] = useState(false);
  const [selectedVarIndex, setSelectedVarIndex] = useState<number | null>(null);

  useEffect(() => {
    log.debug(`Initializing environment variables for server: ${serverName}`, { variableCount: Object.keys(initialEnv).length });
    // Convert initial env object to array of variables
    const vars = Object.entries(initialEnv).map(([key, varData]) => {
      // Handle both string values (old format) and object values (new format)
      const value = typeof varData === 'object' && varData !== null && 'value' in varData
        ? varData.value
        : varData as string;
        
      const metadata = typeof varData === 'object' && varData !== null && 'metadata' in varData
        ? varData.metadata
        : { isSecret: isSecretEnvVar(key) };
      
      // Check if the value is a global variable binding
      const bindingMatch = value.match(/\$\{global:([^}]+)\}/);
      
      if (bindingMatch) {
        const boundTo = bindingMatch[1];
        return {
          key,
          value,
          isSecret: metadata.isSecret,
          isBound: true,
          boundTo
        };
      }
      
      // Check if this is an encrypted value
      const isEncrypted = typeof value === 'string' && 
        (value.startsWith('encrypted:') || value.startsWith('encrypted_failed:'));
      
      // For encrypted values, show asterisks in the UI for security
      const displayValue = isEncrypted ? MASKED_STRING : value;

      return {
        key,
        value: displayValue,
        isSecret: metadata.isSecret,
        isEncrypted: isEncrypted,
      };
    });

    setVariables(vars);
  }, [initialEnv]);

  const handleAddVariable = () => {
    log.debug('Adding new environment variable');
    setVariables([...variables, { key: '', value: '', isSecret: false }]);
    setIsEditing(true);
  };

  const handleRemoveVariable = async (index: number) => {
    log.debug(`Removing environment variable at index: ${index}`);
    const variable = variables[index];
    
    // If this is a global environment variable and we have an onDelete handler
    if (serverName === "Global" && onDelete && variable.key) {
      try {
        await onDelete(variable.key);
        // Remove from local state after successful deletion
        setVariables(variables.filter((_, i) => i !== index));
      } catch (error) {
        log.error(`Failed to delete environment variable: ${variable.key}`, error);
      }
    } else {
      // For non-global variables or if no onDelete handler, just update local state
      setVariables(variables.filter((_, i) => i !== index));
      setIsEditing(true);
    }
  };

  // Validate that a variable name contains only alphanumeric characters and underscores
  const isValidVariableName = (name: string): boolean => {
    return /^[a-zA-Z0-9_]+$/.test(name);
  };

  const handleVariableChange = (
    index: number,
    field: 'key' | 'value' | 'isSecret',
    value: string | boolean
  ) => {
    const newVariables = [...variables];
    if (field === 'isSecret') {
      const currentVariable = newVariables[index];
      const newIsSecret = value as boolean;
      
      // Check if switching from secret to normal mode
      if (currentVariable.isSecret && !newIsSecret) {
        // When switching from secret to normal, clear the value and show warning
        newVariables[index] = {
          ...currentVariable,
          isSecret: newIsSecret,
          value: '', // Clear the value
          isEncrypted: false, // No longer encrypted
          showWarning: true // Show warning
        };
      } else {
        // Normal toggle of secret flag
        newVariables[index] = {
          ...currentVariable,
          isSecret: newIsSecret,
        };
      }
    } else {
      const strValue = value as string;
      
      // If changing the value of an encrypted field, clear the isEncrypted flag
      // and remove the originalValue since we're replacing it
      const updatedVariable = {
        ...newVariables[index],
        [field]: strValue,
        isSecret:
          field === 'key'
            ? isSecretEnvVar(strValue)
            : newVariables[index].isSecret,
      };
      
      // Validate variable name if the field is 'key'
      if (field === 'key') {
        updatedVariable.isValidKey = strValue === '' || isValidVariableName(strValue);
      }
      
      if (field === 'value') {
        if (newVariables[index].isEncrypted) {
          // User is changing an encrypted value, so it's no longer encrypted
          updatedVariable.isEncrypted = false;          
        }

        // If user is entering a value after the warning was shown, clear the warning
        if (newVariables[index].showWarning && strValue) {
          updatedVariable.showWarning = false;
        }
      }
      
      newVariables[index] = updatedVariable;
    }
    setVariables(newVariables);
    setIsEditing(true);
  };

  const handleBindVariable = (index: number) => {
    log.debug(`Opening bind modal for variable at index: ${index}`);
    setSelectedVarIndex(index);
    setShowBindModal(true);
  };

  const handleUnbindVariable = (index: number) => {
    log.debug(`Unbinding variable at index: ${index}`);
    const newVariables = [...variables];
    newVariables[index] = {
      ...newVariables[index],
      isBound: false,
      boundTo: undefined,
    };
    setVariables(newVariables);
    setIsEditing(true);
  };

  const handleSelectGlobalVar = (globalVarKey: string) => {
    if (selectedVarIndex !== null) {
      log.debug(`Binding variable at index ${selectedVarIndex} to global variable: ${globalVarKey}`);
      const newVariables = [...variables];
      newVariables[selectedVarIndex] = {
        ...newVariables[selectedVarIndex],
        isBound: true,
        boundTo: globalVarKey,
        value: `$\{global:${globalVarKey}\}`, // Special syntax to indicate binding
      };
      setVariables(newVariables);
      setShowBindModal(false);
      setSelectedVarIndex(null);
      setIsEditing(true);
    }
  };

  const handleSave = async () => {
    // Check if all variable names are valid
    const hasInvalidKeys = variables.some(v => v.key !== '' && v.isValidKey === false);
    if (hasInvalidKeys) {
      log.error('Cannot save: Some variable names contain invalid characters');
      return;
    }

    log.debug(`Saving environment variables for server: ${serverName}`, { variableCount: variables.length });
    setIsSaving(true);
    try {
      // Create env object with resolved values
      const envObject = variables.reduce(
        (acc, variable) => {
          const { key, value, isBound, boundTo, isSecret, isEncrypted } = variable;
          
          if (!key) return acc; // Skip empty keys

          // If the variable is bound to a global var, store the binding syntax
          if (isBound && boundTo) {
            acc[key] = {
              value: `$\{global:${boundTo}\}`,
              metadata: { isSecret }
            };
          } else {
            // For all other values, store with metadata, unless it is secret and the value is masked.
            if (!(isSecret && value === MASKED_STRING)) {
              acc[key] = {
                value,
                metadata: { isSecret }
              };
            }
          }
          return acc;
        },
        {} as Record<string, { value: string, metadata: { isSecret: boolean } }>
      );

      // Save the environment variables,
      await onSave(envObject);
      setIsEditing(false);

    } catch (error) {
      log.error('Failed to save environment variables:', error);
    }
    setIsSaving(false);
  };

  return (
    <Paper
      sx={{
        p: 3,
        borderRadius: 2,
        border: 1,
        borderColor: (theme) => theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb'
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h6" sx={{ fontWeight: 'semibold' }}>
          Environment Variables - {serverName}
        </Typography>
        <Button
          variant="contained"
          color="primary"
          size="small"
          startIcon={<AddIcon />}
          onClick={handleAddVariable}
        >
          Add Variable
        </Button>
      </Box>

      <Stack spacing={3}>
        {variables.map((variable, index) => (
          <Grid container key={index} spacing={2} alignItems="flex-start">
            <Grid item xs={12} sm={5}>
              <TextField
                fullWidth
                placeholder="Variable name"
                value={variable.key}
                onChange={(e) => handleVariableChange(index, 'key', e.target.value)}
                error={variable.isValidKey === false}
                helperText={variable.isValidKey === false ? "Only alphanumeric characters and underscores allowed" : ""}
                size="small"
              />
            </Grid>
            <Grid item xs={12} sm={5}>
              <TextField
                fullWidth
                type={variable.isSecret ? 'password' : 'text'}
                placeholder={variable.showWarning ? "Re-enter value" : "Value"}
                value={variable.value}
                onChange={(e) => handleVariableChange(index, 'value', e.target.value)}
                InputProps={{
                  readOnly: variable.isBound,
                  startAdornment: variable.isEncrypted ? (
                    <InputAdornment position="start">
                      <LockIcon fontSize="small" titleAccess="This value is stored encrypted" />
                    </InputAdornment>
                  ) : null,
                  endAdornment: variable.isBound ? (
                    <InputAdornment position="end">
                      <Chip
                        size="small"
                        label={`Bound to global: ${variable.boundTo}`}
                        color="primary"
                        variant="outlined"
                        onDelete={() => handleUnbindVariable(index)}
                        deleteIcon={<CancelIcon fontSize="small" />}
                      />
                    </InputAdornment>
                  ) : null
                }}
                error={variable.showWarning}
                helperText={variable.showWarning ? "You must re-enter the value after switching from secret to normal mode" : ""}
                size="small"
                sx={{
                  bgcolor: (theme) => variable.isBound ? 
                    (theme.palette.mode === 'dark' ? '#1a1a1a' : '#f9fafb') : 
                    theme.palette.background.paper
                }}
              />
            </Grid>
            <Grid item xs={12} sm={2}>
              <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5 }}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={variable.isSecret}
                      onChange={(e) => handleVariableChange(index, 'isSecret', e.target.checked)}
                      size="small"
                    />
                  }
                  label="Secret"
                  sx={{ mr: 1 }}
                />
                {!variable.isBound && (
                  <IconButton
                    size="small"
                    color="primary"
                    onClick={() => handleBindVariable(index)}
                    title="Bind to global variable"
                    sx={{ mr: 1 }}
                  >
                    <LinkIcon fontSize="small" />
                  </IconButton>
                )}
                <IconButton
                  size="small"
                  color="error"
                  onClick={() => handleRemoveVariable(index)}
                  title="Remove variable"
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            </Grid>
          </Grid>
        ))}
      </Stack>

      {/* Bind Modal */}
      <Modal
        open={showBindModal}
        onClose={() => {
          setShowBindModal(false);
          setSelectedVarIndex(null);
        }}
      >
        <Box sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 400,
          maxWidth: '90%',
          bgcolor: 'background.paper',
          boxShadow: 24,
          p: 4,
          borderRadius: 2
        }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Bind to Global Variable
          </Typography>
          
          {Object.keys(globalEnvVars).length === 0 ? (
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              No global variables available. Add some in Settings first.
            </Typography>
          ) : (
            <Box sx={{ maxHeight: 300, overflow: 'auto', mb: 2 }}>
              {Object.entries(globalEnvVars).map(([key, value]) => (
                <Button
                  key={key}
                  fullWidth
                  variant="text"
                  onClick={() => handleSelectGlobalVar(key)}
                  sx={{
                    justifyContent: 'space-between',
                    textAlign: 'left',
                    mb: 1,
                    p: 1,
                    borderRadius: 1
                  }}
                >
                  <Typography variant="body2">{key}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {value && typeof value === 'object' && value.metadata && value.metadata.isSecret
                      ? MASKED_STRING
                      : value && typeof value === 'object'
                        ? value.value
                        : value}
                  </Typography>
                </Button>
              ))}
            </Box>
          )}
          
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="outlined"
              onClick={() => {
                setShowBindModal(false);
                setSelectedVarIndex(null);
              }}
            >
              Cancel
            </Button>
          </Box>
        </Box>
      </Modal>

      {isEditing && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 3 }}>
          <Button
            variant="contained"
            color="success"
            onClick={handleSave}
            disabled={isSaving || variables.some(v => v.key !== '' && v.isValidKey === false)}
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </Box>
      )}
    </Paper>
  );
};

export default EnvEditor;
