"use client";

import React, { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Box, Button, Alert, Paper, TextField, InputAdornment } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import { v4 as uuidv4 } from 'uuid';

import ModelList from '@/frontend/components/models/list/ModelList';
import ModelModal from '@/frontend/components/models/modal';
import { createLogger } from '@/utils/logger';
import { Model } from '@/shared/types';
import { getModelService, ModelResult } from '@/frontend/services/model';
import Spinner from '@/frontend/components/shared/Spinner';
import { collectFolders } from '@/utils/shared/cardGrouping';

const log = createLogger('app/models/ModelClient');

interface ModelClientProps {
  initialModels: Model[];
}

export default function ModelClient({ initialModels }: ModelClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [models, setModels] = useState(initialModels);
  const [searchTerm, setSearchTerm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [serviceReady, setServiceReady] = useState(false);
  // In-memory draft for a brand-new model (add mode). It is NOT persisted to disk until the
  // user clicks Save, which replaces the old approach of writing a "preliminary" model record
  // immediately and cleaning it up on cancel.
  const [newModelDraft, setNewModelDraft] = useState<Model | null>(null);

  const isAddMode = searchParams.get('add') === '1';

  // Create the draft once when entering add mode; clear it when leaving.
  useEffect(() => {
    if (isAddMode) {
      setNewModelDraft(prev => prev ?? ({
        id: uuidv4(),
        name: '',
        displayName: '',
        description: '',
        ApiKey: '',
        baseUrl: '',
        provider: 'openai',
        promptTemplate: '',
        temperature: '0.0',
      } as Model));
    } else {
      setNewModelDraft(null);
    }
  }, [isAddMode]);

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
  const editId = searchParams.get('edit');
  // In add mode the model comes from the in-memory draft; in edit mode from the loaded list.
  const currentModel: Model | null = isAddMode
    ? newModelDraft
    : (editId ? models.find(m => m.id === editId) ?? null : null);
  const isModalOpen = isAddMode ? Boolean(newModelDraft) : Boolean(editId);

  const handleSave = async (model: Model): Promise<ModelResult> => {
    log.info('Saving model', { modelId: model.id, modelName: model.name, mode: isAddMode ? 'add' : 'update' });
    setIsLoading(true);
    try {
      const service = getModelService();
      // First-time save of a new model creates it; otherwise update the existing record.
      const result = isAddMode ? await service.addModel(model) : await service.updateModel(model);
      if (result.success) {
        // Refresh models list
        const updatedModels = await service.loadModels();
        setModels(updatedModels);

        // Close modal by removing query param
        setNewModelDraft(null);
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
    log.info('Opening add-model modal');
    // Just open the modal in add mode - the draft lives in memory until the user saves.
    router.push('/models?add=1');
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

  // Assign or clear a model's organizing folder (#80). Reuses the normal update
  // path: we re-load the fresh record (whose ApiKey arrives MASKED from the
  // backend) and PUT it back with the new folder. The backend treats the masked
  // placeholder as "keep the stored key unchanged", so a folder-only save can
  // neither leak nor clobber an API key.
  const handleSetFolder = async (modelId: string, folder: string | undefined) => {
    log.info('Setting model folder', { modelId, folder });
    setIsLoading(true);
    try {
      const service = getModelService();
      const model = await service.getModel(modelId);
      if (!model) {
        setError('Model not found.');
        return;
      }
      const result = await service.updateModel({ ...model, folder });
      if (!result.success) {
        setError(result.error || 'Failed to move model to folder.');
        return;
      }
      const updatedModels = await service.loadModels();
      setModels(updatedModels);
    } catch (error: any) {
      log.error('Failed to set model folder', error);
      setError(error?.message || 'Failed to move model to folder. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Toggle a model's favorite flag (#146). Reuses the same update seam as folders:
  // re-load the fresh record (whose ApiKey arrives MASKED from the backend) and
  // PUT it back with the flipped flag. The backend treats the masked placeholder
  // as "keep the stored key unchanged", so a favorite-only save can neither leak
  // nor clobber an API key. Missing/false reads as "not a favorite".
  const handleToggleFavorite = async (modelId: string) => {
    log.info('Toggling model favorite', { modelId });
    setIsLoading(true);
    try {
      const service = getModelService();
      const model = await service.getModel(modelId);
      if (!model) {
        setError('Model not found.');
        return;
      }
      const nextFavorite = !model.favorite;
      const result = await service.updateModel({ ...model, favorite: nextFavorite || undefined });
      if (!result.success) {
        setError(result.error || 'Failed to update favorite.');
        return;
      }
      const updatedModels = await service.loadModels();
      setModels(updatedModels);
    } catch (error: any) {
      log.error('Failed to toggle model favorite', error);
      setError(error?.message || 'Failed to update favorite. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCloseModal = async () => {
    // Nothing to clean up: an unsaved new model only ever lived in memory.
    setNewModelDraft(null);
    router.push('/models');
  };

  // Filter models by name/displayName for the search box (consistent with the
  // Flows and MCP list pages, which both offer search).
  const filteredModels = searchTerm.trim()
    ? models.filter(m => {
        const q = searchTerm.toLowerCase();
        return (
          (m.displayName || '').toLowerCase().includes(q) ||
          (m.name || '').toLowerCase().includes(q)
        );
      })
    : models;

  return (
    <>
      {/* Toolbar with search + add, matching the Flows/MCP list toolbars */}
      <Paper elevation={1} sx={{ mb: 2, p: 1 }}>
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 1,
            alignItems: { xs: 'stretch', sm: 'center' },
            justifyContent: 'space-between',
          }}
        >
          <TextField
            placeholder="Search models..."
            variant="outlined"
            size="small"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
            sx={{ maxWidth: { sm: 300 }, width: '100%' }}
          />
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            onClick={handleAdd}
            data-tour="add-model"
          >
            Add Model
          </Button>
        </Box>
      </Paper>

      {error && (
        <Box sx={{ mb: 2 }}>
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        </Box>
      )}

      <ModelList
        models={filteredModels}
        isLoading={isLoading}
        onAdd={handleAdd}
        onUpdate={handleEdit}
        onDelete={handleDelete}
        folders={collectFolders(models, (m) => m.folder)}
        onSetFolder={handleSetFolder}
        onToggleFavorite={handleToggleFavorite}
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
