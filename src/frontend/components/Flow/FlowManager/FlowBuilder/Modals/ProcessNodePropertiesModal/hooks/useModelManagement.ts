import { useState, useEffect, useCallback } from 'react';
import { modelService } from '@/frontend/services/model';
import { Model } from '@/shared/types/model';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('components/flow/FlowBuilder/Modals/ProcessNodePropertiesModal/hooks/useModelManagement.ts');

const useModelManagement = (open: boolean, nodeData: any, setNodeData: (data: any) => void, setPromptTemplate: (template: string) => void, setIsModelBound: (isBound: boolean) => void) => {
  log.debug('useModelManagement: Entering hook');
  const [models, setModels] = useState<Model[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load models when modal opens
  useEffect(() => {
    log.debug('useModelManagement useEffect: Checking if modal is open', { open });
    if (open) {
      // Clear the cache to force a fresh load of models
      loadModels();
    }
  }, [open]);

  // Keep the cached technical name (properties.modelName) honest — silently, with no user
  // action required. It's a display-only cache (execution binds by boundModel id), so if the
  // model was renamed since binding we just refresh it here instead of nagging the user to
  // "re-open and re-save". Guarded on an actual difference so it can't loop.
  useEffect(() => {
    if (models.length === 0) return;
    const boundModel = nodeData?.properties?.boundModel;
    if (!boundModel) return;
    const current = models.find((m) => m.id === boundModel);
    if (!current || !current.name) return;
    if (nodeData?.properties?.modelName === current.name) return;

    setNodeData((prev: any) => {
      if (!prev || prev.properties?.modelName === current.name) return prev;
      return {
        ...prev,
        properties: { ...prev.properties, modelName: current.name },
      };
    });
  }, [models, nodeData?.properties?.boundModel, nodeData?.properties?.modelName, setNodeData]);

  // Load models from the service
  const loadModels = async () => {
    log.debug('loadModels: Entering method');
    setIsLoadingModels(true);
    setLoadError(null);
    try {
      const modelsList = await modelService.loadModels();
      setModels(modelsList);
    } catch (error) {
      log.warn('loadModels: Failed to load models:', error);
      setLoadError('Failed to load models');
    }
    setIsLoadingModels(false);
  };

  const handleModelSelect = useCallback((modelId: string) => {
    log.debug('handleModelSelect: Entering method', { modelId });
    // Find the selected model
    const selectedModel = models.find(model => model.id === modelId);

    if (selectedModel) {
      // Update node data with the selected model
      setNodeData((prev: any) => {
        if (!prev) return null;

        // Use the model's display name as the node label if it's not already set
        const newLabel = prev.label === 'Process Node' ? (selectedModel.displayName || selectedModel.name) : prev.label;

        return {
          ...prev,
          label: newLabel,
          properties: {
            ...prev.properties,
            boundModel: modelId,
            modelName: selectedModel.name,
            // Do not overwrite the existing prompt template
          },
        };
      });

      // Do not overwrite the prompt template with the model's prompt template
      setIsModelBound(true);
    }
  }, [models, setNodeData, setPromptTemplate, setIsModelBound]);

  const handleUnbindModel = useCallback(() => {
    log.debug('handleUnbindModel: Entering method');
    setNodeData((prev: any) => {
      if (!prev) return null;

      // Remove model binding properties but preserve promptTemplate
      const { boundModel, modelName, ...restProperties } = prev.properties;

      return {
        ...prev,
        properties: {
          ...restProperties,
          // Keep the existing prompt template
          promptTemplate: restProperties.promptTemplate || '',
        },
      };
    });

    setIsModelBound(false);
  }, [setNodeData, setIsModelBound]);

  return { models, isLoadingModels, loadError, handleModelSelect, handleUnbindModel };
};

export default useModelManagement;
