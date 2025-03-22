"use client";

import React, { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Box, Button, Alert } from '@mui/material';
import { v4 as uuidv4 } from 'uuid';

import ModelList from '@/frontend/components/models/list/ModelList';
import ModelModal from '@/frontend/components/models/modal';
import { createLogger } from '@/utils/logger';
import { Model } from '@/shared/types';
import { modelService, ModelResult } from '@/frontend/services/model';

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
      const result = await modelService.updateModel(model);
      if (result.success) {
        // Refresh models list
        const updatedModels = await modelService.loadModels();
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
        encryptedApiKey: '',
        provider: 'openai'
      };
      
      const result = await modelService.addModel(preliminaryModel);
      if (result.success && result.model) {
        // Update models list
        const updatedModels = await modelService.loadModels();
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
      await modelService.deleteModel(modelId);
      
      // Refresh models list
      const updatedModels = await modelService.loadModels();
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
        await modelService.deleteModel(modelId);
        // Refresh models list
        const updatedModels = await modelService.loadModels();
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
