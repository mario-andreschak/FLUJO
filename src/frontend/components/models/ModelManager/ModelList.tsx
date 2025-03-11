"use client";

import React from 'react';
import { Grid, CircularProgress, Box } from '@mui/material';
import ModelCard from './ModelCard';
import { Model } from '@/shared/types';

interface ModelListProps {
  models: Model[];
  isLoading: boolean;
  onAdd: (model: Model) => Promise<void>;
  onUpdate: (model: Model) => Promise<void>;
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

  return (
    <Grid container spacing={2}>
      {!models || models.length === 0 ? (
        <Grid item xs={12}>
          <Box textAlign="center" py={4}>
            No models found
          </Box>
        </Grid>
      ) : models.map((model) => (
        <Grid item xs={12} sm={6} md={4} key={model.id}>
          <ModelCard
            model={model}
            onEdit={() => onUpdate(model)}
            onDelete={() => onDelete(model.id)}
          />
        </Grid>
      ))}
    </Grid>
  );
};

export default ModelList;
