"use client";

import React, { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Box, Button, Alert } from '@mui/material';
import { v4 as uuidv4 } from 'uuid';

import ModelList from '@/frontend/components/models/list/ModelList';
import ModelModal from '@/frontend/components/models/modal';
import { createLogger } from '@/utils/logger';
import { Model } from '@/shared/types';
import { getModelService, ModelResult } from '@/frontend/services/model';
import Spinner from '@/frontend/components/shared/Spinner';

const log = createLogger('app/models/ModelClient');

interface ModelClientProps {
  initialModels: Model[];
}

export default function ModelClient({ initialModels }: ModelClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [models, setModels] = useState(initialModels);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [serviceReady, setServiceReady] = useState(false);

  // Ensure service is ready before using it
  useEffect(() => {
    try {
      const service = getModelService();
      if (service && typeof service.loadModels === 'function') {
        setServiceReady(true);
        log.debug('Model service is ready');
      }
    } catch (error) {
      log.warn('Model service not ready, retrying...', error);
      const timer = setTimeout(() => {
        try {
          const service = getModelService();
          if (service && typeof service.loadModels === 'function') {
            setServiceReady(true);
            log.debug('Model service is now ready');
          }
        } catch (retryError) {
          log.warn('Model service still not ready', retryError);
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, []);

  // Show loading spinner if service is not ready
  if (!serviceReady) {
    log.debug('Waiting for model service to be ready...');
    return <Spinner />;
  }

  // Get modal state from URL
  const modelId = searchParams.get('edit');
  const isModalOpen = Boolean(modelId);
  // Get current model from models list
  const currentModel = modelId ? models.find(m => m.id === modelId) ?? null : null;

  const handleSave = async (model: Model): Promise<ModelResult> => {
    log.info('Saving model', { modelId: model.id, modelName: model.name });
    setIsLoading(true);
    try {
      log.debug('Updating existing model');
      const service = getModelService();
      const result = await service.updateModel(model);
      if (result.success) {
        // Refresh models list
        const updatedModels = await service.loadModels();
        setModels(updatedModels);

        // Close modal by removing query param
        router.push('/models');
        return { success: true, model: result.model };
      } else {
        setError(result.error || 'Failed to save model.');
        return { success: false, error: result.error };
      }
    } catch (error: any) {
      log.error('Failed to save model', error);
      setError(error?.message || 'Failed to save model. Please try again.');
      return { success: false, error: error?.message || 'Failed to save model' };
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleEdit = async (model: Model): Promise<ModelResult> => {
    log.info('Editing model', { modelId: model.id, modelName: model.name });
    // Open modal by adding query param
    router.push(`/models?edit=${model.id}`);
    return { success: true };
  };

  const handleAdd = async () => {
    log.info('Creating preliminary model');
    setIsLoading(true);
    try {
      // Create a preliminary model
      const preliminaryModel: Model = {
        id: uuidv4(),
        name: '',
        displayName: '',
        ApiKey: '',
        provider: 'openai'
      };
      
      const service = getModelService();
      const result = await service.addModel(preliminaryModel);
      if (result.success && result.model) {
        // Update models list
        const updatedModels = await service.loadModels();
        setModels(updatedModels);

        // Open modal with the new model's ID
        router.push(`/models?edit=${result.model.id}`);
        return { success: true };
      } else {
        log.error('Failed to create preliminary model', result.error);
        setError(result.error || 'Failed to create model. Please try again.');
        return { success: false, error: result.error || 'Failed to add model' };
      }
    } catch (error: any) {
      log.error('Failed to create preliminary model', JSON.stringify(error));
      setError(error?.message || 'Failed to create model. Please try again.');
      return { success: false, error: error?.message || 'Failed to add model' };
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (modelId: string) => {
    log.info('Deleting model', { modelId });
    setIsLoading(true);
    try {
      const service = getModelService();
      await service.deleteModel(modelId);
      
      // Refresh models list
      const updatedModels = await service.loadModels();
      setModels(updatedModels);
      
    } catch (error) {
      log.error('Failed to delete model', error);
      setError('Failed to delete model. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCloseModal = async () => {
    // If we're closing a new model that hasn't been saved properly
    if (modelId && currentModel && !currentModel.name) {
      log.info('Cleaning up unsaved preliminary model', { modelId });
      try {
        const service = getModelService();
        await service.deleteModel(modelId);
        // Refresh models list
        const updatedModels = await service.loadModels();
        setModels(updatedModels);
      } catch (error) {
        log.warn('Failed to cleanup preliminary model', JSON.stringify(error));
        // Don't show error to user since this is cleanup
      }
    }
    
    // Close modal by removing query param
    router.push('/models');
  };

  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
        <Button
          variant="contained"
          color="primary"
          onClick={handleAdd}
        >
          Add Model
        </Button>
      </Box>
      
      {error && (
        <Box sx={{ mb: 2 }}>
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        </Box>
      )}

      <ModelList
        models={models}
        isLoading={isLoading}
        onAdd={handleAdd}
        onUpdate={handleEdit}
        onDelete={handleDelete}
      />

      {/* Only render modal when we have a valid model ID */}
      {isModalOpen && currentModel ? (
          <ModelModal
            open={isModalOpen}
            model={currentModel}
            onSave={handleSave}
            onClose={handleCloseModal}
          />
        ) : null
      }
    </>
  );
}
