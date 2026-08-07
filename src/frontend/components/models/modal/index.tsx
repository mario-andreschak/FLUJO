"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createLogger } from '@/utils/logger';
import {
  Dialog,
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
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { Link as LinkIcon, Cancel as CancelIcon } from '@mui/icons-material';
import { useStorage } from '@/frontend/contexts/StorageContext';
import PromptBuilder, { PromptBuilderRef } from '@/frontend/components/shared/PromptBuilder';
import { Model } from '@/shared/types';
import { NormalizedModel } from '@/shared/types/model/response';
import {
  ModelProvider,
  ModelAdapter,
  PROVIDER_PROFILES,
  getModelConfigurationCapabilities,
  getProviderProfile,
} from '@/shared/types/model/provider';
import { MASKED_API_KEY } from '@/shared/types/constants';
import { modelService } from '@/frontend/services/model';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';
import { useAskFlujoPage } from '@/frontend/contexts/AskFlujoContext';
import type { AskFlujoUiAction } from '@/frontend/types/askFlujo';
import { highlightAskFlujoElement } from '@/frontend/utils/askFlujoActions';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';

const log = createLogger('frontend/components/models/modal');

import { ModelResult } from '@/frontend/services/model';

const discoveredModelMetadata = (model: NormalizedModel): Partial<Model> => ({
  ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
  ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
  ...(model.supportsTools !== undefined ? { supportsTools: model.supportsTools } : {}),
  ...(model.supportedParameters !== undefined ? { supportedParameters: model.supportedParameters } : {}),
  ...(model.inputModalities !== undefined ? { inputModalities: model.inputModalities } : {}),
  ...(model.outputModalities !== undefined ? { outputModalities: model.outputModalities } : {}),
  ...(model.visionInputCapability !== undefined ? { visionInputCapability: model.visionInputCapability } : {}),
});

export interface ModelModalProps {
  open: boolean;
  model: Model;  // Never null: edit mode passes the loaded model, add mode an in-memory draft
  onSave: (model: Model) => Promise<ModelResult>;
  onClose: () => void;
}

export const ModelModal = ({ open, model, onSave, onClose }: ModelModalProps) => {
  const { t } = useI18n();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const router = useRouter();
  const { globalEnvVars, settings } = useStorage();
  const [formState, setFormState] = useState<Partial<Model>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [info, setInfo] = useState<string | null>(null);
  const [isApiKeyBound, setIsApiKeyBound] = useState(false);
  const [boundToGlobalVar, setBoundToGlobalVar] = useState<string | null>(null);
  const [showBindModal, setShowBindModal] = useState(false);
  const [openRouterModels, setOpenRouterModels] = useState<NormalizedModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const promptBuilderRef = useRef<PromptBuilderRef>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const askEditableFields = useMemo(() => [
    'displayName',
    'name',
    'description',
    'baseUrl',
    'promptTemplate',
    'temperature',
    'reasoningEffort',
    'thinkingLevel',
    'thinkingBudget',
    'serviceTier',
    'contextWindow',
    'maxTurns',
    'maxTokens',
  ] as const, []);

  const highlightModelField = useCallback((field: string) => {
    const root = [...document.querySelectorAll('[data-ask-flujo-model-id]')]
      .find(element => element.getAttribute('data-ask-flujo-model-id') === model.id) ?? null;
    const named = root
      ? [...root.querySelectorAll('[name]')].find(element => element.getAttribute('name') === field) ?? null
      : null;
    const target = named?.closest('.MuiFormControl-root') ?? root;
    return highlightAskFlujoElement(target);
  }, [model.id]);

  const handleAskFlujoAction = useCallback((action: AskFlujoUiAction) => {
    if (action.target.kind !== 'model-field' || !action.target.field) {
      return { success: false, message: 'That model UI target is not supported.' };
    }
    const field = action.target.field;
    if (!askEditableFields.includes(field as typeof askEditableFields[number])) {
      return { success: false, message: `The model field "${field}" is read-only for Ask FLUJO.` };
    }
    if (action.type === 'highlight') {
      const highlighted = highlightModelField(field);
      return {
        success: highlighted,
        message: highlighted ? `Highlighted ${field}.` : `Could not find ${field} on screen.`,
      };
    }
    const numericFields = new Set(['thinkingBudget', 'contextWindow', 'maxTurns', 'maxTokens']);
    if (numericFields.has(field)) {
      if (typeof action.value !== 'number' || !Number.isFinite(action.value)) {
        return { success: false, message: `${field} must be a finite number.` };
      }
    } else if (typeof action.value !== 'string') {
      return { success: false, message: `${field} must be text.` };
    }
    setFormState(current => ({ ...current, [field]: action.value }));
    window.requestAnimationFrame(() => highlightModelField(field));
    return { success: true, message: `Updated ${field} in the unsaved form. Review it, then Save.` };
  }, [askEditableFields, highlightModelField]);

  useAskFlujoPage({
    scopeId: `model:${model.id}`,
    pageType: 'model',
    route: '/models',
    title: formState.displayName || model.displayName || model.name || 'Model',
    identifiers: { modelId: model.id },
    data: {
      model: {
        ...formState,
        id: model.id,
        ApiKey: formState.ApiKey ? '[REDACTED]' : '',
      },
      saved: false,
    },
    capabilities: {
      highlightTargets: askEditableFields.map(field => ({ kind: 'model-field', field })),
      editableTargets: askEditableFields.map(field => ({ kind: 'model-field', field })),
      notes: [
        'This is the live, unsaved model form.',
        'API keys are never included in Ask FLUJO context and cannot be edited by Ask FLUJO.',
      ],
    },
  }, handleAskFlujoAction, 100);

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

  // Debounced effect for fetching models when technical name changes
  useEffect(() => {
    // Clear any existing timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // Only set up debounced fetch if we have the required data
    if (formState.baseUrl) {
      debounceTimeoutRef.current = setTimeout(() => {
        log.debug("Debounced fetchModels triggered", { 
          name: formState.name, 
          baseUrl: formState.baseUrl,
          searchTerm: formState.name ? `"${formState.name}"` : 'none'
        });
        // Pass the current input value as search term for server-side filtering
        fetchModels(formState.baseUrl!, formState.name);
      }, 100); // 100ms delay
    }

    // Cleanup function
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [formState.name, formState.baseUrl]);

  // Cleanup timeout on component unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  const fetchModels = async (baseUrl: string, searchTerm?: string) => {
    log.debug("fetchModels called", { 
      baseUrl, 
      searchTerm: searchTerm ? `"${searchTerm}"` : 'none',
      apiKey: formState.ApiKey ? "present" : "not present", 
      isApiKeyBound 
    });
    setIsLoadingModels(true);
    setErrors({});
    try {
      // Pass the key the user is currently entering directly to the backend so the provider's
      // model list can be fetched WITHOUT persisting the model first. When the key wasn't
      // edited (masked placeholder), send nothing and let the backend use the stored key
      // looked up by model id (existing models only).
      const apiKeyForFetch = isApiKeyBound && boundToGlobalVar
        ? `\${global:${boundToGlobalVar}}`
        : (formState.ApiKey && formState.ApiKey !== MASKED_API_KEY ? formState.ApiKey : undefined);

      const fetchedModels = await modelService.fetchProviderModels(baseUrl, model.id, searchTerm, apiKeyForFetch);
      log.debug("Models fetched successfully", { 
        count: fetchedModels?.length,
        searchTerm: searchTerm ? `"${searchTerm}"` : 'none'
      });
      
      if (Array.isArray(fetchedModels)) {
        setOpenRouterModels(fetchedModels);
        // Editing an existing model should discover metadata too; requiring the
        // user to re-select the already-exact technical name would not be
        // automatic. Provider values intentionally refresh stale catalogue
        // metadata, while custom display text remains untouched.
        const exactModel = fetchedModels.find(candidate => candidate.id === formState.name);
        if (exactModel) {
          setFormState(prev => prev.name === exactModel.id ? {
            ...prev,
            ...discoveredModelMetadata(exactModel),
          } : prev);
        }
        log.info("Models set in state", { 
          count: fetchedModels.length,
          searchTerm: searchTerm ? `"${searchTerm}"` : 'none'
        });
      } else {
        log.warn("Unexpected API response format", { models: fetchedModels });
        setOpenRouterModels([]);
      }
    } catch (error) {
      log.warn("Error fetching models", { baseUrl, searchTerm, error });
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
          ApiKey: !model.name ? '' : MASKED_API_KEY
        }));
      }
    } else {
      // New model defaults
      setFormState({
        name: '',
        displayName: '',
        description: '',
        ApiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        provider: 'openai' as ModelProvider,
        adapter: 'openai' as ModelAdapter,
        promptTemplate: '',
        temperature: '0.0',
      });
      setIsApiKeyBound(false);
      setBoundToGlobalVar(null);
    }
    setErrors({});
    setInfo(null);
  }, [open, model]);

  // Note: the API key is intentionally NOT persisted as the user types. It is sent directly
  // to the provider-fetch endpoint for listing models, and only saved (encrypted) when the
  // user clicks Save. This avoids writing a half-configured model + plaintext key to disk.

  // The provider/SDK is now chosen explicitly via the Provider dropdown (no
  // longer inferred from the base URL). The currently-selected profile is
  // derived from the stored provider + adapter.
  const currentProfile = getProviderProfile(formState.provider, formState.adapter);
  const configurationCapabilities = getModelConfigurationCapabilities(
    formState.provider,
    formState.adapter,
    formState.name,
  );
  const visibleProviderModels = useMemo(
    () => settings?.experimental?.showModelsWithoutToolCapabilities
      ? openRouterModels
      : openRouterModels.filter(candidate => candidate.supportsTools !== false),
    [openRouterModels, settings?.experimental?.showModelsWithoutToolCapabilities],
  );

  // Apply a provider profile: pins the vendor (provider) and SDK (adapter) and
  // prefills the default base URL (empty for native SDK / CLI providers).
  const handleSelectProfile = (profileId: string) => {
    const profile = PROVIDER_PROFILES.find(p => p.id === profileId);
    if (!profile) return;
    setFormState(prev => ({
      ...prev,
      provider: profile.provider,
      adapter: profile.adapter,
      baseUrl: profile.baseUrl,
    }));
    setErrors(prev => ({ ...prev, baseUrl: '' }));
  };

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
      newErrors.name = t('models.modal.nameRequired');
    }
    if (!formState.displayName?.trim()) {
      newErrors.displayName = t('models.modal.displayNameRequired');
    }
    if (configurationCapabilities.creativity && formState.temperature?.trim()) {
      const creativity = Number(formState.temperature);
      if (
        !Number.isFinite(creativity) ||
        creativity < configurationCapabilities.creativity.min ||
        creativity > configurationCapabilities.creativity.max
      ) {
        newErrors.temperature = t('models.modal.creativityRange', {
          min: configurationCapabilities.creativity.min,
          max: configurationCapabilities.creativity.max,
        });
      }
    }
    // Codex may run keyless via the machine's `codex login` (ChatGPT plan).
    if (!isApiKeyBound && !formState.ApiKey?.trim() && currentProfile.adapter !== 'codex-cli') {
      newErrors.ApiKey = t('models.modal.apiKeyRequired');
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    try {
      // The frontend never holds the real key. When it wasn't edited this session,
      // formState.ApiKey is the masked placeholder, which the backend interprets as
      // "keep the existing key". A "${global:VAR}" binding or a freshly typed key is sent
      // through as-is. Encryption happens on the backend.
      const result: ModelResult = await onSave({
        id: model.id,
        name: formState.name!,
        displayName: formState.displayName!,
        description: formState.description,
        ApiKey: formState.ApiKey,
        baseUrl: formState.baseUrl,
        provider: formState.provider!,
        adapter: formState.adapter || 'openai',
        promptTemplate: formState.promptTemplate,
        temperature: configurationCapabilities.creativity ? formState.temperature : undefined,
        reasoningEffort: configurationCapabilities.effortLevels?.includes(formState.reasoningEffort!)
          ? formState.reasoningEffort
          : undefined,
        thinkingLevel: configurationCapabilities.thinkingLevels?.includes(formState.thinkingLevel!)
          ? formState.thinkingLevel
          : undefined,
        thinkingBudget: configurationCapabilities.thinkingBudget
          ? formState.thinkingBudget
          : undefined,
        serviceTier: configurationCapabilities.priority
          ? (formState.serviceTier || 'default')
          : undefined,
        contextWindow: formState.contextWindow,
        supportsTools: formState.supportsTools,
        supportedParameters: formState.supportedParameters,
        inputModalities: formState.inputModalities,
        outputModalities: formState.outputModalities,
        visionInputCapability: formState.visionInputCapability ?? (
          Array.isArray(formState.inputModalities)
            ? (formState.inputModalities.some((value) => /^(?:image|vision)$/i.test(value)) ? 'supported' : 'unsupported')
            : 'unknown'
        ),
        maxTurns: formState.maxTurns,
        maxTokens: configurationCapabilities.maxOutputTokens ? formState.maxTokens : undefined,
      } as Model);

      if (result.success) {
        router.refresh();
      } else {
        setErrors({
          submit: result.error || t('models.saveFailed')
        });
      }
    } catch (error: any) {
      log.error('Failed to save model', { error });
      setErrors({
        submit: error?.message || t('models.saveFailed'),
      });
    }
  };

  const levelLabelKeys: Record<string, TranslationKey> = {
    minimal: 'models.modal.level.minimal',
    low: 'models.modal.level.low',
    medium: 'models.modal.level.medium',
    high: 'models.modal.level.high',
    xhigh: 'models.modal.level.xhigh',
    max: 'models.modal.level.max',
  };
  const levelLabel = (level: string) => levelLabelKeys[level]
    ? t(levelLabelKeys[level])
    : level;

  return (
    <Dialog 
      open={open} 
      onClose={onClose} 
      maxWidth="xl" 
      fullWidth
      fullScreen={isMobile}
      PaperProps={{
        'data-ask-flujo-model-id': model.id,
        sx: {
          width: isMobile ? '100%' : '95vw',
          height: isMobile ? '100dvh' : '90vh',
          maxWidth: isMobile ? '100%' : '95vw',
          maxHeight: isMobile ? '100dvh' : '90vh',
        }
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <DialogHeaderActions
          title={model.name ? t('models.modal.editTitle') : t('models.modal.createTitle')}
          onClose={onClose}
        />
        <DialogContent
          sx={{
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            minHeight: 0,
            overflowY: { xs: 'auto', md: 'hidden' },
            px: { xs: 2, sm: 3 },
          }}
        >
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
          
          <Grid container spacing={2} sx={{ flexGrow: 1, minHeight: { md: 0 } }}>
            {/* Left Column - Model Configuration */}
            <Grid item xs={12} md={6} sx={{ height: { xs: 'auto', md: '100%' }, minWidth: 0 }}>
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  height: { xs: 'auto', md: '100%' },
                  pr: { xs: 0, md: 2 },
                  overflowY: { xs: 'visible', md: 'auto' },
                }}
              >
                <Typography variant="h6" gutterBottom>
                  {t('models.modal.connectionDetails')}
                </Typography>
                
                <TextField
                  name="displayName"
                  autoFocus
                  margin="dense"
                  label={t('models.modal.displayName')}
                  fullWidth
                  required
                  value={formState.displayName || ''}
                  onChange={(e) => handleChange('displayName', e.target.value)}
                  error={!!errors.displayName}
                  helperText={errors.displayName || t('models.modal.displayNameHelp')}
                />

                <FormControl fullWidth margin="dense">
                  <InputLabel id="provider-profile-label">{t('models.modal.provider')}</InputLabel>
                  <Select
                    name="provider"
                    labelId="provider-profile-label"
                    label={t('models.modal.provider')}
                    value={currentProfile.id}
                    onChange={(e) => handleSelectProfile(e.target.value)}
                  >
                    {PROVIDER_PROFILES.map(profile => (
                      <MenuItem key={profile.id} value={profile.id}>
                        {profile.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, mb: 1, display: 'block' }}>
                  {t('models.modal.usesSdk', { sdk: currentProfile.sdkLabel })}
                  {currentProfile.adapter === 'claude-cli'
                    ? ` ${t('models.modal.claudeAuthHelp')}`
                    : currentProfile.adapter === 'codex-cli'
                      ? ` ${t('models.modal.codexAuthHelp')}`
                      : ''}
                </Typography>

                {currentProfile.showBaseUrl && (
                  <TextField
                    name="baseUrl"
                    margin="dense"
                    label={t('models.card.baseUrl')}
                    fullWidth
                    value={formState.baseUrl || ''}
                    onChange={(e) => handleChange('baseUrl', e.target.value)}
                    helperText={t('models.modal.baseUrlHelp')}
                  />
                )}

                <Box sx={{ position: 'relative', mt: 1, mb: 1 }}>
                  <TextField
                    name="ApiKey"
                    margin="dense"
                    label={t('models.modal.apiKey')}
                    fullWidth
                    required={!isApiKeyBound && currentProfile.adapter !== 'codex-cli'}
                    type={isApiKeyBound ? "text" : "password"}
                    value={formState.ApiKey || ''}
                    onChange={(e) => handleChange('ApiKey', e.target.value)}
                    error={!!errors.ApiKey}
                    helperText={errors.ApiKey || (currentProfile.adapter === 'codex-cli'
                      ? t('models.modal.apiKeyOptionalCodex')
                      : t('models.modal.apiKeyRequiredProvider'))}
                    InputProps={{
                      readOnly: isApiKeyBound,
                      endAdornment: (
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                          {isApiKeyBound ? (
                            <IconButton
                              onClick={handleUnbindApiKey}
                              size="small"
                              title={t('models.modal.unbindGlobal')}
                            >
                              <CancelIcon />
                            </IconButton>
                          ) : (
                            <IconButton
                              onClick={handleBindApiKey}
                              size="small"
                              title={t('models.modal.bindGlobal')}
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
                  options={
                    currentProfile.showBaseUrl
                      ? visibleProviderModels.map(model => model.id)
                      : (currentProfile.defaultModels ?? [])
                  }
                  value={formState.name || ''}
                  onChange={(_, newValue) => {
                    const selected = openRouterModels.find(candidate => candidate.id === newValue);
                    setFormState(prev => ({
                      ...prev,
                      name: newValue || '',
                      ...(selected ? {
                        description: selected.description ?? prev.description,
                        ...discoveredModelMetadata(selected),
                      } : {}),
                    }));
                    setErrors(prev => ({ ...prev, name: '' }));
                  }}
                  onInputChange={(_, newValue) => {
                    handleChange('name', newValue);
                    // Debounced API call is now handled by useEffect
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
                      label={t('models.modal.technicalName')}
                      required
                      error={!!errors.name}
                      helperText={errors.name || t('models.modal.technicalNameHelp')}
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
                  noOptionsText={t('models.modal.noMatches')}
                  loadingText={t('models.modal.loadingModels')}
                />

                <TextField
                  name="description"
                  margin="dense"
                  label={t('models.modal.description')}
                  fullWidth
                  multiline
                  rows={3}
                  value={formState.description || ''}
                  onChange={(e) => handleChange('description', e.target.value)}
                />

                {configurationCapabilities.creativity && (
                  <TextField
                    name="temperature"
                    margin="dense"
                    label={t('models.modal.creativity')}
                    fullWidth
                    type="number"
                    value={formState.temperature ?? ''}
                    onChange={(e) => handleChange('temperature', e.target.value)}
                    error={!!errors.temperature}
                    inputProps={configurationCapabilities.creativity}
                    helperText={errors.temperature || t('models.modal.creativityHelp', {
                      min: configurationCapabilities.creativity.min,
                      max: configurationCapabilities.creativity.max,
                    })}
                  />
                )}

                {configurationCapabilities.effortLevels && (
                  <FormControl fullWidth margin="dense">
                    <InputLabel id="reasoning-effort-label">{t('models.modal.effort')}</InputLabel>
                    <Select
                      name="reasoningEffort"
                      labelId="reasoning-effort-label"
                      label={t('models.modal.effort')}
                      value={formState.reasoningEffort || ''}
                      onChange={(e) => setFormState(prev => ({
                        ...prev,
                        reasoningEffort: e.target.value
                          ? e.target.value as Model['reasoningEffort']
                          : undefined,
                      }))}
                    >
                      <MenuItem value=""><em>{t('models.modal.providerDefault')}</em></MenuItem>
                      {configurationCapabilities.effortLevels.map(level => (
                        <MenuItem key={level} value={level}>
                          {levelLabel(level)}
                        </MenuItem>
                      ))}
                    </Select>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, ml: 1.75 }}>
                      {t('models.modal.effortHelp')}
                    </Typography>
                  </FormControl>
                )}

                {configurationCapabilities.thinkingLevels && (
                  <FormControl fullWidth margin="dense">
                    <InputLabel id="thinking-level-label">{t('models.modal.thinkingLevel')}</InputLabel>
                    <Select
                      name="thinkingLevel"
                      labelId="thinking-level-label"
                      label={t('models.modal.thinkingLevel')}
                      value={formState.thinkingLevel || ''}
                      onChange={(e) => setFormState(prev => ({
                        ...prev,
                        thinkingLevel: e.target.value
                          ? e.target.value as Model['thinkingLevel']
                          : undefined,
                      }))}
                    >
                      <MenuItem value=""><em>{t('models.modal.providerDefault')}</em></MenuItem>
                      {configurationCapabilities.thinkingLevels.map(level => (
                        <MenuItem key={level} value={level}>
                          {levelLabel(level)}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}

                {configurationCapabilities.thinkingBudget && (
                  <TextField
                    name="thinkingBudget"
                    margin="dense"
                    label={t('models.modal.thinkingBudget')}
                    fullWidth
                    type="number"
                    value={formState.thinkingBudget ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const parsed = raw === '' ? undefined : Number(raw);
                      setFormState(prev => ({
                        ...prev,
                        thinkingBudget: parsed !== undefined && Number.isFinite(parsed) && parsed >= -1
                          ? Math.floor(parsed)
                          : undefined,
                      }));
                    }}
                    inputProps={{ min: -1, step: 1 }}
                    helperText={t('models.modal.thinkingBudgetHelp')}
                  />
                )}

                {configurationCapabilities.priority && (
                  <FormControl fullWidth margin="dense">
                    <InputLabel id="service-tier-label">{t('models.modal.priority')}</InputLabel>
                    <Select
                      name="serviceTier"
                      labelId="service-tier-label"
                      label={t('models.modal.priority')}
                      value={formState.serviceTier || 'default'}
                      onChange={(e) => setFormState(prev => ({
                        ...prev,
                        serviceTier: e.target.value as Model['serviceTier'],
                      }))}
                    >
                      <MenuItem value="default">{t('models.modal.standard')}</MenuItem>
                      <MenuItem value="priority">{t('models.modal.priorityFaster')}</MenuItem>
                    </Select>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, ml: 1.75 }}>
                      {t('models.modal.priorityHelp')}
                    </Typography>
                  </FormControl>
                )}

                <TextField
                  name="contextWindow"
                  margin="dense"
                  label={t('models.modal.contextWindow')}
                  fullWidth
                  type="number"
                  value={formState.contextWindow ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const parsed = raw === '' ? undefined : Number(raw);
                    setFormState(prev => ({
                      ...prev,
                      contextWindow: parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined,
                    }));
                  }}
                  helperText={t('models.modal.contextWindowHelp')}
                />

                <TextField
                  name="maxTurns"
                  margin="dense"
                  label={t('models.modal.maxTurns')}
                  fullWidth
                  type="number"
                  value={formState.maxTurns ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const parsed = raw === '' ? undefined : Number(raw);
                    setFormState(prev => ({
                      ...prev,
                      maxTurns: parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined,
                    }));
                  }}
                  inputProps={{ min: 1 }}
                  helperText={t('models.modal.maxTurnsHelp')}
                />

                {configurationCapabilities.maxOutputTokens && (
                  <TextField
                    name="maxTokens"
                    margin="dense"
                    label={t('models.modal.maxOutputTokens')}
                    fullWidth
                    type="number"
                    value={formState.maxTokens ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const parsed = raw === '' ? undefined : Number(raw);
                      setFormState(prev => ({
                        ...prev,
                        maxTokens: parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined,
                      }));
                    }}
                    inputProps={{ min: 1 }}
                    helperText={t('models.modal.maxOutputTokensHelp')}
                  />
                )}
              </Box>
            </Grid>
            
            {/* Right Column - Prompt Builder */}
            <Grid item xs={12} md={6} sx={{ height: { xs: 400, md: '100%' }, minWidth: 0 }}>
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  height: '100%',
                  minHeight: 0,
                  pl: { xs: 0, md: 2 },
                }}
              >
                <Typography variant="h6" gutterBottom>
                  {t('models.modal.promptTemplate')}
                </Typography>
                <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
                width: { xs: 'calc(100% - 32px)', sm: 400 },
                maxWidth: 400,
                bgcolor: 'background.paper',
                boxShadow: 24,
                p: { xs: 2, sm: 4 },
                borderRadius: 1,
                zIndex: 9999,
              }}
            >
              <Typography variant="h6" component="h2" sx={{ mb: 2 }}>
                {t('models.modal.bindTitle')}
              </Typography>
              
              {Object.keys(globalEnvVars).length === 0 ? (
                <Typography sx={{ mb: 2 }}>
                  {t('models.modal.noGlobals')}
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
                  {t('common.cancel')}
                </Button>
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ flexShrink: 0 }}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="contained" color="primary">
            {t('models.modal.save')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default ModelModal;
