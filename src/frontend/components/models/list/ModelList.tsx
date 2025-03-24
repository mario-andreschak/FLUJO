"use client";

import React from 'react';
import { Grid, CircularProgress, Box } from '@mui/material';
import ModelCard from './ModelCard';
import { Model } from '@/shared/types';
import { ModelResult } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/models/list/ModelList');

interface ModelListProps {
  models: Model[];
  isLoading: boolean;
  onAdd: () => void;
  onUpdate: (model: Model) => Promise<ModelResult>;
  onDelete: (id: string) => Promise<void>;
}

export const ModelList = ({ models, isLoading, onAdd, onUpdate, onDelete }: ModelListProps) => {
    if (isLoading) {
        return (
            <Box display="flex" justifyContent="center" py={4}>
                <CircularProgress />
            </Box>
        );
    }

    const handleUpdate = async (model: Model): Promise<void> => {
        const result = await onUpdate(model);
        if (!result.success) {
          log.error('Failed to update model in ModelList', result.error);
          // Consider displaying an error message to the user here,
          // perhaps using a state variable to show an alert.
        }
    }

    return (
        <Grid container spacing={2}>
            {!models || models.length === 0 ? (
                <Grid item xs={12}>
                    <Box textAlign="center" py={4}>
                        No models found
                    </Box>
                </Grid>
            ) : (
                models.map((model) => (
                    <Grid item xs={12} sm={6} md={4} key={model.id}>
                        <ModelCard
                            model={model}
                            onEdit={() => handleUpdate(model)}
                            onDelete={() => onDelete(model.id)}
                        />
                    </Grid>
                ))
            )}
        </Grid>
    );
};

export default ModelList;
