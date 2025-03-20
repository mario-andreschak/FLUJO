"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import debounce from 'lodash/debounce';
import { createLogger } from '@/utils/logger';
// Create a logger instance for this component
const log = createLogger('frontend/components/models/ModelManager/ModelModal');

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
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { Model } from '@/shared/types';
import { ModelProvider } from '@/shared/types/model/provider';
import { modelService } from '@/frontend/services/model';
import { ReasoningDefaultPattern, ToolCallDefaultPattern } from '@/shared/types/constants';

export interface ModelModalProps {
  open: boolean;
  model: Model | null;
  onSave: (model: Model) => void;
  onClose: () => void;
}

export const ModelModal = ({ open, model, onSave, onClose }: ModelModalProps) => {
  const { globalEnvVars } = useStorage();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [nameError, setNameError] = useState('');
  const [displayNameError, setDisplayNameError] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [promptTemplate, setPromptTemplate] = useState('');
  const [reasoningSchema, setReasoningSchema] = useState('');
  const [temperature, setTemperature] = useState('0.0');
  const [functionCallingSchema, setFunctionCallingSchema] = useState('');
  const [isApiKeyBound, setIsApiKeyBound] = useState(false);
  const [boundToGlobalVar, setBoundToGlobalVar] = useState<string | null>(null);
  const [showBindModal, setShowBindModal] = useState(false);
  const [openRouterModels, setOpenRouterModels] = useState<Array<{id: string, name: string, description?: string}>>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [provider, setProvider] = useState<ModelProvider>('openai');
  // Create a debounced function for name input
  const debouncedFetchModels = useCallback(
    debounce((baseUrl: string) => {
      if (baseUrl) {
        log.info(`Debounced fetch models for ${baseUrl}`);
        fetchModels(baseUrl);
      }
    }, 500), // 500ms delay
    []
  );

  // Clear models list when modal opens
  useEffect(() => {
    if (open) {
      setOpenRouterModels([]);
    }
  }, [open]);

  // Fetch models when baseUrl changes and set provider
  useEffect(() => {
    log.debug("Base URL changed", { baseUrl });
    
    // Clear the models list when baseUrl changes
    setOpenRouterModels([]);
    
    // Set provider based on baseUrl
    if (baseUrl.includes('openrouter.ai')) {
      setProvider('openrouter');
    } else if (baseUrl.includes('api.x.ai')) {
      setProvider('xai');
    } else if (baseUrl.includes('generativelanguage.googleapis.com')) {
      setProvider('gemini');
    } else if (baseUrl.includes('api.anthropic.com')) {
      setProvider('anthropic');
    } else if (baseUrl.includes('localhost:11434') || baseUrl.includes('127.0.0.1:11434')) {
      setProvider('ollama');
    } else if (baseUrl.includes('api.mistral.ai')) {
      setProvider('mistral');
    } else {
      setProvider('openai');
    }
    
    if (baseUrl) {
      log.info(`Fetching models for ${baseUrl}`);
      fetchModels(baseUrl);
    }
  }, [baseUrl]);

const fetchModels = async (baseUrl: string) => {
  log.debug("fetchModels called", { baseUrl, apiKey: apiKey ? "present" : "not present", isApiKeyBound });
  setIsLoadingModels(true);
  setError(null);
  try {
    // Get the actual API key based on the current state
    let actualApiKey: string | undefined;
    
    // If editing an existing model, use the model ID to look up the API key on the backend
    if (model) {
      log.debug("Using existing model ID for API key lookup:", model.id);
      const models = await modelService.fetchProviderModels(baseUrl, model.id);
      
      if (Array.isArray(models)) {
        setOpenRouterModels(models);
        log.info("Models set in state for existing model", { count: models.length });
      } else {
        log.warn("Unexpected API response format", { models });
        setOpenRouterModels([]);
      }
      setIsLoadingModels(false);
      return;
    }
    
    // For new models:
    // If the API key is bound to a global variable, extract the actual key
    if (isApiKeyBound && boundToGlobalVar && globalEnvVars[boundToGlobalVar]) {
      const globalValue = globalEnvVars[boundToGlobalVar];
      actualApiKey = typeof globalValue === 'object' && globalValue !== null && 'value' in globalValue
        ? globalValue.value as string
        : globalValue as string;
      log.debug("Using API key from global variable:", boundToGlobalVar);
    } 
    // Otherwise use the directly entered API key
    else if (!isApiKeyBound && apiKey) {
      actualApiKey = apiKey;
      log.debug("Using directly entered API key");
    }
    
    // Fetch models with the temporary API key for new models
    const models = await modelService.fetchProviderModels(baseUrl, undefined, actualApiKey);
    
    log.debug("Models fetched successfully", { count: models?.length });
    
    if (Array.isArray(models)) {
      setOpenRouterModels(models);
      log.info("Models set in state", { count: models.length });
    } else {
      log.warn("Unexpected API response format", { models });
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

  useEffect(() => {
    const loadModel = async () => {
      if (model) {
        setName(model.name);
        setDisplayName(model.displayName || model.name); // Default to name if displayName is not set
        setDescription(model.description || '');
        setBaseUrl(model.baseUrl || '');
        setPromptTemplate(model.promptTemplate || '');
        setReasoningSchema(model.reasoningSchema || '');
        setTemperature(model.temperature || '0.0');
        setFunctionCallingSchema(model.functionCallingSchema || '');
        
        // Set provider from model if available, otherwise determine from baseUrl
        if (model.provider) {
          setProvider(model.provider);
        } else if (model.baseUrl) {
          // Determine provider from baseUrl
          if (model.baseUrl.includes('openrouter.ai')) {
            setProvider('openrouter');
          } else if (model.baseUrl.includes('api.x.ai')) {
            setProvider('xai');
          } else if (model.baseUrl.includes('generativelanguage.googleapis.com')) {
            setProvider('gemini');
          } else if (model.baseUrl.includes('api.anthropic.com')) {
            setProvider('anthropic');
          } else if (model.baseUrl.includes('localhost:11434') || model.baseUrl.includes('127.0.0.1:11434')) {
            setProvider('ollama');
          } else if (model.baseUrl.includes('api.mistral.ai')) {
            setProvider('mistral');
          } else {
            setProvider('openai');
          }
        }
        
        // Check if API key is bound to a global variable
        const apiKeyValue = model.encryptedApiKey || '';
        const bindingMatch = apiKeyValue.match(/\$\{global:([^}]+)\}/);
        
        if (bindingMatch) {
          const boundTo = bindingMatch[1];
          setIsApiKeyBound(true);
          setBoundToGlobalVar(boundTo);
          setApiKey(`Bound to global: ${boundTo}`);
        } else {
          setIsApiKeyBound(false);
          setBoundToGlobalVar(null);
          
          try {
            // Check if encryption is initialized
            const isEncryptionConfigured = await modelService.isEncryptionConfigured();
            
            if (isEncryptionConfigured) {
              // For security, we no longer display decrypted API keys
              // Just set a placeholder to indicate it's encrypted
              setApiKey('********');
              
              // Check if using user encryption or default encryption
              const isUserEncryption = await modelService.isUserEncryptionEnabled();
              if (isUserEncryption) {
                setInfo('Your API key is protected with your custom encryption password.');
              } else {
                setInfo('Your API key is protected with default encryption.');
              }
            } else {
              // Initialize default encryption
              try {
                await fetch('/api/encryption/secure', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    action: 'initialize_default'
                  }),
                });
                
                setApiKey('********');
                setInfo('Default encryption has been initialized for your API key.');
              } catch (initError) {
                log.error('Failed to initialize default encryption', { error: initError });
                setApiKey('********');
                setInfo('Error initializing encryption. Please re-enter your API key.');
              }
            }
          } catch (error) {
            log.error('Failed to check encryption status', { error });
            // If there's an error checking encryption status, use a placeholder
            setApiKey('********');
            setInfo('Error checking encryption status. Please re-enter your API key.');
          }
        }
      } else {
        // New model setup
        setName('');
        setDisplayName('');
        setDescription('');
        setApiKey('');
        setBaseUrl('');
        setPromptTemplate('');
        setReasoningSchema('');
        setTemperature('0.0');
        setFunctionCallingSchema('');
        setIsApiKeyBound(false);
        setBoundToGlobalVar(null);
        setError(null);
        setInfo(null);
        
        // Check encryption status for new models
        try {
          const isEncryptionConfigured = await modelService.isEncryptionConfigured();
          
          if (!isEncryptionConfigured) {
            // Initialize default encryption
            try {
              await fetch('/api/encryption/secure', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  action: 'initialize_default'
                }),
              });
              
              setInfo('Default encryption has been initialized for your API key.');
            } catch (initError) {
              log.error('Failed to initialize default encryption', { error: initError });
              setInfo('Error initializing encryption. Your API key will still be encrypted.');
            }
          } else {
            // Check if using user encryption or default encryption
            const isUserEncryption = await modelService.isUserEncryptionEnabled();
            if (isUserEncryption) {
              setInfo('Your API key will be protected with your custom encryption password.');
            } else {
              setInfo('Your API key will be protected with default encryption.');
            }
          }
        } catch (error) {
          log.error('Failed to check encryption status', { error });
          setInfo('Error checking encryption status. Your API key will still be encrypted.');
        }
      }
    };
    loadModel();
  }, [model]);

  const handleBindApiKey = () => {
    setShowBindModal(true);
  };

  const handleUnbindApiKey = () => {
    setIsApiKeyBound(false);
    setBoundToGlobalVar(null);
    setApiKey('');
  };

  const handleSelectGlobalVar = (globalVarKey: string) => {
    setIsApiKeyBound(true);
    setBoundToGlobalVar(globalVarKey);
    setApiKey(`Bound to global: ${globalVarKey}`);
    setShowBindModal(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);

    // Basic validation
    if (!name.trim()) {
      setNameError('Name is required');
      return;
    }

    // API key is required for all providers except OpenRouter
    if (!isApiKeyBound && !apiKey.trim() &&
        baseUrl !== 'https://openrouter.ai/api/v1') {
      setError('API key is required for this provider');
      return;
    }

    let encryptedApiKey: string;
    
    if (isApiKeyBound && boundToGlobalVar) {
      // Use the binding syntax for global variables
      encryptedApiKey = `\${global:${boundToGlobalVar}}`;
    } else if (model && apiKey === '********') {
      // If editing an existing model and the API key is still masked,
      // preserve the original encrypted API key instead of encrypting the mask
      log.debug('Preserving original encrypted API key instead of overwriting with masked value');
      encryptedApiKey = model.encryptedApiKey;
    } else {
      try {
        // Check encryption status
        const isEncryptionConfigured = await modelService.isEncryptionConfigured();
        
        // Encryption should always be configured now with default encryption
        if (!isEncryptionConfigured) {
          // Initialize default encryption if not already initialized
          await fetch('/api/encryption/secure', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              action: 'initialize_default'
            }),
          });
          
          setInfo('Default encryption has been initialized for your API key.');
        }
        
        // Use the encryptApiKey method
        const result = await modelService.encryptApiKey(apiKey);
        
        // Ensure we always have a string
        encryptedApiKey = result || apiKey;
        
        // Check if using user encryption or default encryption
        const isUserEncryption = await modelService.isUserEncryptionEnabled();
        if (isUserEncryption) {
          setInfo('Your API key has been protected with your custom encryption password.');
        } else {
          setInfo('Your API key has been protected with default encryption.');
        }
      } catch (error) {
        log.error('Error checking encryption status', { error });
        // If there's an error, use the API key as is but show a warning
        setInfo('Error with encryption service. Your API key will be stored in plain text.');
        encryptedApiKey = apiKey;
      }
    }

    // Basic validation for display name
    if (!displayName.trim()) {
      setDisplayNameError('Display Name is required');
      return;
    }

    try {
      onSave({
        id: model?.id || uuidv4(),
        name,
        displayName,
        description: description || undefined,
        encryptedApiKey,
        baseUrl: baseUrl || undefined,
        provider,
        promptTemplate: promptTemplate || undefined,
        reasoningSchema: reasoningSchema || undefined,
        temperature: temperature || undefined,
        functionCallingSchema: functionCallingSchema || undefined,
      });
    } catch (error) {
      log.error('Failed to save model', { error });
      setError(error instanceof Error ? error.message : 'Failed to save model');
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
        <DialogTitle>{model ? 'Edit Model' : 'Add Model'}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', height: 'calc(90vh - 130px)' }}>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
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
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    setDisplayNameError('');
                  }}
                  error={!!displayNameError}
                  helperText={displayNameError || "The name shown in the UI"}
                />
                
                <TextField
                  margin="dense"
                  label="Base URL (Optional)"
                  fullWidth
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1, mb: 2 }}>
                  <Button 
                    size="small" 
                    variant="outlined" 
                    onClick={() => {
                      setBaseUrl('https://openrouter.ai/api/v1');
                    }}
                  >
                    OpenRouter
                  </Button>
                  <Button 
                    size="small" 
                    variant="outlined" 
                    onClick={() => setBaseUrl('https://api.x.ai/v1')}
                  >
                    X.ai
                  </Button>
                  <Button 
                    size="small" 
                    variant="outlined" 
                    onClick={() => setBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/')}
                  >
                    Gemini
                  </Button>
                  <Button 
                    size="small" 
                    variant="outlined" 
                    onClick={() => setBaseUrl('https://api.anthropic.com/v1/')}
                  >
                    Anthropic
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => setBaseUrl('http://localhost:11434/v1')}
                  >
                    Ollama
                  </Button>
                </Box>
                
                <Box sx={{ position: 'relative', mt: 2, mb: 1 }}>
                  <TextField
                    margin="dense"
                    label="API Key"
                    fullWidth
                    required={!isApiKeyBound && baseUrl !== 'https://openrouter.ai/api/v1'}
                    type={isApiKeyBound ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => !isApiKeyBound && setApiKey(e.target.value)}
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
                    helperText={
                      baseUrl === 'https://openrouter.ai/api/v1'
                        ? "API key is optional for OpenRouter"
                        : "API key is required for this provider"
                    }
                  />
                </Box>
                
                <Autocomplete
                  freeSolo
                  loading={isLoadingModels}
                  options={openRouterModels.map(model => model.id)}
                  value={name}
                  onChange={(_, newValue) => {
                    setName(newValue || '');
                    setNameError('');
                  }}
                  onInputChange={(_, newInputValue) => {
                    setName(newInputValue);
                    setNameError('');
                    
                    // Trigger debounced fetch when typing in the technical name
                    if (baseUrl && newInputValue) {
                      debouncedFetchModels(baseUrl);
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
                      error={!!nameError}
                      helperText={nameError || "Used for API calls to the LLM. Type to search available models."}
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
                    const { key, ...otherProps } = props;
                    const model = openRouterModels.find(m => m.id === option);
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
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
                
                <TextField
                  margin="dense"
                  label="Temperature"
                  fullWidth
                  type="number"
                  inputProps={{ min: 0, max: 1, step: 0.1 }}
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  helperText="Value between 0 and 1. Lower values make output more deterministic."
                />
                
                {/* Reasoning Pattern and Tool Call Pattern fields are hidden */}
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
                    ref={useRef<PromptBuilderRef>(null)}
                    value={promptTemplate} 
                    onChange={setPromptTemplate}
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
