"use client";

import React, { useState, useEffect } from 'react';
import { Box, Typography, Button, Alert } from '@mui/material';
import ModelList from '@/frontend/components/models/ModelManager/ModelList';
import ModelModal from '@/frontend/components/models/ModelManager/ModelModal';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { createLogger } from '@/utils/logger';
import { Model } from '@/shared/types';
import Spinner from '@/frontend/components/shared/Spinner';

const log = createLogger('app/models/page');

const ModelsPage = () => {
  log.debug('Rendering ModelsPage');
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { models, addModel, updateModel, deleteModel, isEncryptionInitialized, isLoading } = useStorage();

  useEffect(() => {
    log.debug('ModelsPage mounted');
    // With our new encryption system, encryption is always initialized
    // either with default encryption or user-set password
    // So we don't need to show a warning anymore
    setError(null);
  }, []);

  const handleSave = async (model: Model) => {
    log.info('Saving model', { modelId: model.id, modelName: model.name });
    try {
      if (editingModel) {
        log.debug('Updating existing model');
        // Update existing model
        await updateModel(model);
      } else {
        log.debug('Adding new model');
        // Add new model
        await addModel(model);
      }
      log.debug('Model saved successfully');
      setIsFormOpen(false);
      setEditingModel(null);
    } catch (error) {
      log.error('Failed to save model', error);
      setError('Failed to save model. Please try again.');
    }
  };

  const handleEdit = async (model: Model) => {
    log.info('Editing model', { modelId: model.id, modelName: model.name });
    setEditingModel(model);
    setIsFormOpen(true);
  };

  const handleDelete = async (modelId: string) => {
    log.info('Deleting model', { modelId });
    try {
      await deleteModel(modelId);
      log.debug('Model deleted successfully');
    } catch (error) {
      log.error('Failed to delete model', error);
      setError('Failed to delete model. Please try again.');
    }
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          p: 2,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Typography variant="h5">Models</Typography>
        <Button
          variant="contained"
          color="primary"
          onClick={() => {
            setEditingModel(null);
            setIsFormOpen(true);
          }}
        >
          Add Model
        </Button>
      </Box>
      {error && (
        <Box sx={{ p: 2 }}>
          <Alert severity="warning">{error}</Alert>
        </Box>
      )}
      <Box sx={{ p: 2, flex: 1, overflow: 'auto' }}>
        <ModelList 
          models={models}
          isLoading={isLoading}
          onAdd={handleSave}
          onUpdate={handleEdit}
          onDelete={handleDelete}
        />
      </Box>
      <ModelModal
        open={isFormOpen}
        model={editingModel}
        onSave={handleSave}
        onClose={() => {
          setIsFormOpen(false);
          setEditingModel(null);
        }}
      />
    </Box>
  );
};

export default ModelsPage;
