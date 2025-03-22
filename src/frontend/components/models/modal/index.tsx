"use client";

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createLogger } from '@/utils/logger';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Alert,
  Grid,
  Box,
  Typography,
  IconButton,
  Autocomplete,
  CircularProgress,
} from '@mui/material';
import { Link as LinkIcon, Cancel as CancelIcon } from '@mui/icons-material';
import { useStorage } from '@/frontend/contexts/StorageContext';
import PromptBuilder, { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';
import { Model } from '@/shared/types';
import { ModelProvider, PROVIDER_INFO } from '@/shared/types/model/provider';
import { modelService } from '@/frontend/services/model';

const log = createLogger('frontend/components/models/modal');

import { ModelResult } from '@/frontend/services/model';

export interface ModelModalProps {
  open: boolean;
  model: Model;  // Model will never be null since we create a preliminary model first
  onSave: (model: Model) => Promise<ModelResult>;
  onClose: () => void;
}

export const ModelModal = ({ open, model, onSave, onClose }: ModelModalProps) => {
  const router = useRouter();
  const { globalEnvVars } = useStorage();
  const [formState, setFormState] = useState<Partial<Model>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [info, setInfo] = useState<string | null>(null);
  const [isApiKeyBound, setIsApiKeyBound] = useState(false);
  const [boundToGlobalVar, setBoundToGlobalVar] = useState<string | null>(null);
  const [showBindModal, setShowBindModal] = useState(false);
  const [openRouterModels, setOpenRouterModels] = useState<Array<{id: string, name: string, description?: string}>>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const promptBuilderRef = useRef<PromptBuilderRef>(null);

  // Clear models list when modal opens
  useEffect(() => {
    if (open) {
      setOpenRouterModels([]);
    }
  }, [open]);

  // Clear models when baseUrl or apiKey changes
  useEffect(() => {
    if (formState.baseUrl) {
      log.debug("Base URL or API Key changed", { baseUrl: formState.baseUrl });
      // Clear cached models when baseUrl or API key changes
      setOpenRouterModels([]);
    }
  }, [formState.baseUrl, formState.ApiKey]);

  const fetchModels = async (baseUrl: string) => {
    log.debug("fetchModels called", { baseUrl, apiKey: formState.ApiKey ? "present" : "not present", isApiKeyBound });
    setIsLoadingModels(true);
    setErrors({});
    try {
      const fetchedModels = await modelService.fetchProviderModels(baseUrl, model.id);
      log.debug("Models fetched successfully", { count: fetchedModels?.length });
      
      if (Array.isArray(fetchedModels)) {
        setOpenRouterModels(fetchedModels);
        log.info("Models set in state", { count: fetchedModels.length });
      } else {
        log.warn("Unexpected API response format", { models: fetchedModels });
        setOpenRouterModels([]);
      }
    } catch (error) {
      log.warn("Error fetching models", { baseUrl, error });
      // Silently fail - don't show error messages in the UI
      setOpenRouterModels([]);
    } finally {
      setIsLoadingModels(false);
    }
  };

  // Reset form when modal opens/closes or model changes
  useEffect(() => {
    if (open) {
      setFormState({
        ...model,
        displayName: model.displayName || model.name,
      });
      
      // Handle API key binding
      const apiKeyValue = model.ApiKey || '';
      const bindingMatch = apiKeyValue.match(/\$\{global:([^}]+)\}/);
      
      if (bindingMatch) {
        setIsApiKeyBound(true);
        setBoundToGlobalVar(bindingMatch[1]);
      } else {
        setIsApiKeyBound(false);
        setBoundToGlobalVar(null);
        
        // If this is a preliminary model (empty name), leave API key empty
        // Otherwise, mask the existing API key
        setFormState(prev => ({
          ...prev,
          ApiKey: !model.name ? '' : '********'
        }));
      }
    } else {
      // New model defaults
      setFormState({
        name: '',
        displayName: '',
        description: '',
        ApiKey: '',
        baseUrl: '',
        provider: 'openai' as ModelProvider,
        promptTemplate: '',
        temperature: '0.0',
      });
      setIsApiKeyBound(false);
      setBoundToGlobalVar(null);
    }
    setErrors({});
    setInfo(null);
  }, [open, model]);

  // Transfer API key to backend immediately when it changes
  useEffect(() => {
    const updateApiKey = async () => {
      // Only update if API key is defined
      if (!formState.ApiKey) return;

      let newApiKey = formState.ApiKey;

      // Skip if it's the masked value
      if (newApiKey === '********') return;

      // Handle global variable binding
      if (isApiKeyBound && boundToGlobalVar) {
          newApiKey = `\${global:${boundToGlobalVar}}`;
      }

      // Let the backend handle encryption - don't encrypt here
      try {
          await modelService.updateModelApiKey(model.id, newApiKey);
          log.debug('API key updated successfully');
      } catch (error) {
          log.error('Failed to update API key', { error });
          setErrors(prev => ({
              ...prev,
              ApiKey: 'Failed to update API key'
          }));
      }
  };

  updateApiKey();
  }, [formState.ApiKey, isApiKeyBound, boundToGlobalVar, model.id]);

  // Update provider when baseUrl changes
  useEffect(() => {
    if (!formState.baseUrl) return;
    
    let provider: ModelProvider = 'openai';
    if (formState.baseUrl.includes('openrouter.ai')) {
      provider = 'openrouter';
    } else if (formState.baseUrl.includes('api.x.ai')) {
      provider = 'xai';
    } else if (formState.baseUrl.includes('generativelanguage.googleapis.com')) {
      provider = 'gemini';
    } else if (formState.baseUrl.includes('api.anthropic.com')) {
      provider = 'anthropic';
    } else if (formState.baseUrl.includes('localhost:11434') || formState.baseUrl.includes('127.0.0.1:11434')) {
      provider = 'ollama';
    } else if (formState.baseUrl.includes('api.mistral.ai')) {
      provider = 'mistral';
    }
    
    setFormState(prev => ({ ...prev, provider }));
  }, [formState.baseUrl]);

  const handleChange = (field: keyof Model, value: string) => {
    setFormState(prev => ({ ...prev, [field]: value }));
    setErrors(prev => ({ ...prev, [field]: '' }));
  };

  const handleBindApiKey = () => {
    setShowBindModal(true);
  };

  const handleUnbindApiKey = () => {
    setIsApiKeyBound(false);
    setBoundToGlobalVar(null);
    setFormState(prev => ({ ...prev, ApiKey: '' }));
  };

  const handleSelectGlobalVar = (globalVarKey: string) => {
    setIsApiKeyBound(true);
    setBoundToGlobalVar(globalVarKey);
    setFormState(prev => ({ 
      ...prev, 
      ApiKey: `\${global:${globalVarKey}}`
    }));
    setShowBindModal(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};

    // Validation
    if (!formState.name?.trim()) {
      newErrors.name = 'Name is required';
    }
    if (!formState.displayName?.trim()) {
      newErrors.displayName = 'Display Name is required';
    }
    if (!isApiKeyBound && !formState.ApiKey?.trim()) {
      newErrors.ApiKey = 'API key is required';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    try {
      // If editing and API key hasn't changed, preserve the original
      let apiKey = formState.ApiKey;
      if (!isApiKeyBound && apiKey === '********') {
        apiKey = model.ApiKey;
      }
      // Don't encrypt here - let the backend handle encryption

      const result: ModelResult = await onSave({
        id: model.id,
        name: formState.name!,
        displayName: formState.displayName!,
        description: formState.description,
        ApiKey: apiKey,
        baseUrl: formState.baseUrl,
        provider: formState.provider!,
        promptTemplate: formState.promptTemplate,
        temperature: formState.temperature,
      } as Model);

      if (result.success) {
        router.refresh();
      } else {
        setErrors({
          submit: result.error || 'Failed to save model'
        });
      }
    } catch (error: any) {
      log.error('Failed to save model', { error });
      setErrors({
        submit: error?.message || 'Failed to save model',
      });
    }
};

  return (
    <Dialog 
      open={open} 
      onClose={onClose} 
      maxWidth="xl" 
      fullWidth
      PaperProps={{
        sx: {
          width: '95vw',
          height: '90vh',
          maxWidth: '95vw',
          maxHeight: '90vh',
        }
      }}
    >
      <form onSubmit={handleSubmit}>
        <DialogTitle>
          {model ? 'Edit Model' : 'Add Model'}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', height: 'calc(90vh - 130px)' }}>
          {errors.submit && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {errors.submit}
            </Alert>
          )}
          {info && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {info}
            </Alert>
          )}
          
          <Grid container spacing={2} sx={{ flexGrow: 1 }}>
            {/* Left Column - Model Configuration */}
            <Grid item xs={6} sx={{ height: '100%' }}>
              <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', pr: 2 }}>
                <Typography variant="h6" gutterBottom>
                  Model Configuration
                </Typography>
                
                <TextField
                  autoFocus
                  margin="dense"
                  label="Display Name"
                  fullWidth
                  required
                  value={formState.displayName || ''}
                  onChange={(e) => handleChange('displayName', e.target.value)}
                  error={!!errors.displayName}
                  helperText={errors.displayName || "The name shown in the UI"}
                />
                
                <TextField
                  margin="dense"
                  label="Base URL (Optional)"
                  fullWidth
                  value={formState.baseUrl || ''}
                  onChange={(e) => handleChange('baseUrl', e.target.value)}
                />
                
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1, mb: 2 }}>
                  {Object.entries(PROVIDER_INFO).map(([providerKey, providerData]) => (
                    <Button
                      key={providerKey}
                      size="small"
                      variant="outlined"
                      onClick={() => handleChange('baseUrl', providerData.baseUrl)}
                    >
                      {providerData.label}
                    </Button>
                  ))}
                </Box>
                
                <Box sx={{ position: 'relative', mt: 2, mb: 1 }}>
                  <TextField
                    margin="dense"
                    label="API Key"
                    fullWidth
                    required={!isApiKeyBound}
                    type={isApiKeyBound ? "text" : "password"}
                    value={formState.ApiKey || ''}
                    onChange={(e) => handleChange('ApiKey', e.target.value)}
                    error={!!errors.ApiKey}
                    helperText={errors.ApiKey || "API key is required for this provider"}
                    InputProps={{
                      readOnly: isApiKeyBound,
                      endAdornment: (
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                          {isApiKeyBound ? (
                            <IconButton 
                              onClick={handleUnbindApiKey}
                              size="small"
                              title="Unbind from global variable"
                            >
                              <CancelIcon />
                            </IconButton>
                          ) : (
                            <IconButton 
                              onClick={handleBindApiKey}
                              size="small"
                              title="Bind to global variable"
                            >
                              <LinkIcon />
                            </IconButton>
                          )}
                        </Box>
                      ),
                    }}
                  />
                </Box>

                <Autocomplete
                  freeSolo
                  loading={isLoadingModels}
                  options={openRouterModels.map(model => model.id)}
                  value={formState.name || ''}
                  onChange={(_, newValue) => {
                    handleChange('name', newValue || '');
                  }}
                  onInputChange={(_, newValue) => {
                    handleChange('name', newValue);
                    
                    // Fetch models when user types in the technical name field
                    if (newValue && newValue.length >= 0 && formState.baseUrl) {
                      fetchModels(formState.baseUrl);
                    }
                  }}
                  filterOptions={(options, state) => {
                    const inputValue = state.inputValue.toLowerCase();
                    
                    // If no input, return all options
                    if (!inputValue) return options;
                    
                    // Simple fuzzy search implementation
                    return options.filter(option => {
                      const optionLower = option.toLowerCase();
                      
                      // Exact match or substring match gets highest priority
                      if (optionLower.includes(inputValue)) return true;
                      
                      // Fuzzy match - check if characters appear in sequence
                      let optionIndex = 0;
                      let inputIndex = 0;
                      
                      while (optionIndex < optionLower.length && inputIndex < inputValue.length) {
                        if (optionLower[optionIndex] === inputValue[inputIndex]) {
                          inputIndex++;
                        }
                        optionIndex++;
                      }
                      
                      // If we matched all characters in the input, it's a fuzzy match
                      return inputIndex === inputValue.length;
                    });
                  }}
                  ListboxProps={{
                    style: { 
                      maxHeight: '300px',
                      overflow: 'auto'
                    }
                  }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      margin="dense"
                      label="Technical Name"
                      required
                      error={!!errors.name}
                      helperText={errors.name || "Used for API calls to the LLM. Type to search available models."}
                      InputProps={{
                        ...params.InputProps,
                        endAdornment: (
                          <>
                            {isLoadingModels ? <CircularProgress color="inherit" size={20} /> : null}
                            {params.InputProps.endAdornment}
                          </>
                        ),
                      }}
                    />
                  )}
                  renderOption={(props, option) => {
                    const model = openRouterModels.find(m => m.id === option);
                    // Extract key from props to avoid React warning about spreading key prop
                    const { key, ...otherProps } = props;
                    return (
                      <li key={key} {...otherProps} style={{ borderBottom: '1px solid rgba(0,0,0,0.1)', padding: '8px 16px' }}>
                        <Box>
                          <Typography variant="body1" fontWeight="bold">{option}</Typography>
                          {model?.description && (
                            <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
                              {model.description}
                            </Typography>
                          )}
                        </Box>
                      </li>
                    );
                  }}
                  noOptionsText="No matching models found"
                  loadingText="Loading models..."
                />

                <TextField
                  margin="dense"
                  label="Description"
                  fullWidth
                  multiline
                  rows={3}
                  value={formState.description || ''}
                  onChange={(e) => handleChange('description', e.target.value)}
                />
                
                <TextField
                  margin="dense"
                  label="Temperature"
                  fullWidth
                  type="number"
                  inputProps={{ min: 0, max: 1, step: 0.1 }}
                  value={formState.temperature || '0.0'}
                  onChange={(e) => handleChange('temperature', e.target.value)}
                  helperText="Value between 0 and 1. Lower values make output more deterministic."
                />
              </Box>
            </Grid>
            
            {/* Right Column - Prompt Builder */}
            <Grid item xs={6} sx={{ height: '100%' }}>
              <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', pl: 2 }}>
                <Typography variant="h6" gutterBottom>
                  Prompt Template
                </Typography>
                <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', height: 'calc(100% - 32px)' }}>
                  <PromptBuilder 
                    ref={promptBuilderRef}
                    value={formState.promptTemplate || ''} 
                    onChange={(value) => handleChange('promptTemplate', value)}
                    label=""
                    height="100%"
                  />
                </Box>
              </Box>
            </Grid>
          </Grid>
          
          {/* Bind Modal */}
          {showBindModal && (
            <Box
              sx={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 400,
                bgcolor: 'background.paper',
                boxShadow: 24,
                p: 4,
                borderRadius: 1,
                zIndex: 9999,
              }}
            >
              <Typography variant="h6" component="h2" sx={{ mb: 2 }}>
                Bind to Global Variable
              </Typography>
              
              {Object.keys(globalEnvVars).length === 0 ? (
                <Typography sx={{ mb: 2 }}>
                  No global variables available. Add some in Settings first.
                </Typography>
              ) : (
                <Box sx={{ maxHeight: 300, overflow: 'auto', mb: 2 }}>
                  {Object.entries(globalEnvVars).map(([key, value]) => (
                    <Button
                      key={key}
                      onClick={() => handleSelectGlobalVar(key)}
                      fullWidth
                      sx={{ 
                        justifyContent: 'flex-start', 
                        textAlign: 'left',
                        mb: 1,
                        p: 1,
                        '&:hover': { bgcolor: 'action.hover' }
                      }}
                    >
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                        <Typography>{key}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {key.toLowerCase().includes('key') ||
                           key.toLowerCase().includes('secret') ||
                           key.toLowerCase().includes('token') ||
                           key.toLowerCase().includes('password')
                            ? '********'
                            : (typeof value === 'object' && value !== null && 'value' in value
                              ? value.value
                              : value as string)}
                        </Typography>
                      </Box>
                    </Button>
                  ))}
                </Box>
              )}
              
              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button onClick={() => setShowBindModal(false)}>
                  Cancel
                </Button>
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" color="primary">
            Save
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default ModelModal;
