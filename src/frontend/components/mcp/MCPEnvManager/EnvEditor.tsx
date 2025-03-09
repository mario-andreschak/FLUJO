'use client';

import React, { useState, useEffect } from 'react';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp/MCPEnvManager/EnvEditor');
import { useStorage } from '@/frontend/contexts/StorageContext';
import { Link as LinkIcon, Cancel as CancelIcon, LockOutlined as LockIcon } from '@mui/icons-material';
import { isSecretEnvVar } from '@/utils/shared';
import { mcpService } from '@/frontend/services/mcp';
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
    <div className="border rounded-lg p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold">
          Environment Variables - {serverName}
        </h3>
        <button
          type="button"
          onClick={handleAddVariable}
          className="px-3 py-1 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600"
        >
          Add Variable
        </button>
      </div>

      <div className="space-y-4">
        {variables.map((variable, index) => (
          <div key={index} className="flex gap-4 items-start">
            <div className="flex-1 flex gap-2">
              <div className="w-2/5 relative">
                <input
                  type="text"
                  placeholder="Variable name"
                  className={`w-full p-2 border rounded-md ${variable.isValidKey === false ? 'border-red-500' : ''}`}
                  value={variable.key}
                  onChange={(e) =>
                    handleVariableChange(index, 'key', e.target.value)
                  }
                />
                {variable.isValidKey === false && (
                  <div className="text-xs text-red-500 mt-1">
                    Only alphanumeric characters and underscores allowed
                  </div>
                )}
              </div>
              <div className="relative w-3/5">
                <div className="relative">
                  <input
                    type={variable.isSecret ? 'password' : 'text'}
                    placeholder={variable.showWarning ? "Re-enter value" : "Value"}
                    className={`w-full p-2 border rounded-md 
                      ${variable.isBound ? 'bg-gray-100' : ''} 
                      ${variable.isEncrypted ? 'pl-8' : ''} 
                      ${variable.showWarning ? 'border-yellow-500' : ''}`}
                    value={variable.value}
                    onChange={(e) =>
                      handleVariableChange(index, 'value', e.target.value)
                    }
                    readOnly={variable.isBound}
                  />
                  {variable.isEncrypted && (
                    <div className="absolute left-2 top-1/2 transform -translate-y-1/2 text-gray-500" title="This value is stored encrypted">
                      <LockIcon fontSize="small" />
                    </div>
                  )}
                  {variable.showWarning && (
                    <div className="text-xs text-yellow-600 mt-1">
                      You must re-enter the value after switching from secret to normal mode
                    </div>
                  )}
                </div>
                {variable.isBound && (
                  <div className="absolute right-2 top-2 flex items-center">
                    <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded mr-1">
                      Bound to global: {variable.boundTo}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleUnbindVariable(index)}
                      className="text-red-500"
                      title="Unbind variable"
                    >
                      <CancelIcon fontSize="small" />
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center mt-2">
              <label className="flex items-center mr-4 text-sm">
                <input
                  type="checkbox"
                  className="mr-2"
                  checked={variable.isSecret}
                  onChange={(e) =>
                    handleVariableChange(index, 'isSecret', e.target.checked)
                  }
                />
                Secret
              </label>
              {!variable.isBound && (
                <button
                  type="button"
                  onClick={() => handleBindVariable(index)}
                  className="text-blue-500 hover:text-blue-700 mr-2"
                  title="Bind to global variable"
                >
                  <LinkIcon fontSize="small" />
                </button>
              )}
              <button
                type="button"
                onClick={() => handleRemoveVariable(index)}
                className="text-red-500 hover:text-red-700"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Bind Modal */}
      {showBindModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">Bind to Global Variable</h3>
            
            {Object.keys(globalEnvVars).length === 0 ? (
              <p className="text-gray-500 mb-4">
                No global variables available. Add some in Settings first.
              </p>
            ) : (
              <div className="max-h-60 overflow-y-auto mb-4">
                {Object.entries(globalEnvVars).map(([key, value]) => (
                  <button
                    type="button"
                    key={key}
                    onClick={() => handleSelectGlobalVar(key)}
                    className="w-full text-left p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded mb-1 flex justify-between items-center"
                  >
                    <span>{key}</span>
                    <span className="text-xs text-gray-500">
                      {value && typeof value === 'object' && value.metadata && value.metadata.isSecret
                        ? MASKED_STRING
                        : value && typeof value === 'object'
                          ? value.value
                          : value}
                    </span>
                  </button>
                ))}
              </div>
            )}
            
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowBindModal(false);
                  setSelectedVarIndex(null);
                }}
                className="px-4 py-2 border rounded-lg"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {isEditing && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving || variables.some(v => v.key !== '' && v.isValidKey === false)}
            className="px-4 py-2 bg-green-500 text-white rounded-md hover:bg-green-600 disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      )}
    </div>
  );
};

export default EnvEditor;
