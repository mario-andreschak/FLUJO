"use client";

import React, { useState } from 'react';
import {
  Card,
  CardContent,
  CardActions,
  Typography,
  IconButton,
  Box,
  Tooltip,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import KeyIcon from '@mui/icons-material/Key';
import ScienceIcon from '@mui/icons-material/Science';
import { Model } from '@/shared/types';
import { ModelTestResult } from '@/shared/types/model/response';
import { getModelService } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';
import ModelTestDialog from './ModelTestDialog';

const log = createLogger('frontend/components/models/list/ModelCard');

export interface ModelCardProps {
  model: Model;
  onEdit: () => void;
  onDelete: () => void;
}

export const ModelCard = ({ model, onEdit, onDelete }: ModelCardProps) => {
  const [testOpen, setTestOpen] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const runTest = async () => {
    setTestLoading(true);
    setTestError(null);
    setTestResult(null);
    try {
      // Pass only the id: the stored key is resolved/decrypted on the backend
      // and never leaves it.
      const result = await getModelService().testModel({ modelId: model.id });
      setTestResult(result);
    } catch (error) {
      log.error('Model test failed', { modelId: model.id, error });
      setTestError(error instanceof Error ? error.message : 'Failed to run test');
    } finally {
      setTestLoading(false);
    }
  };

  const handleOpenTest = () => {
    setTestOpen(true);
    runTest();
  };

  return (
    <Card elevation={2} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ flexGrow: 1 }}>
        <Typography variant="h6" gutterBottom>
          {model.displayName || model.name}
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mb: 2 }}
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {model.description}
        </Typography>
        <Box sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
          <KeyIcon fontSize="small" color="action" />
          <Typography variant="body2" color="text.secondary">
            API Key: ••••••••
          </Typography>
        </Box>
        {model.baseUrl && (
          <Tooltip title={model.baseUrl} arrow placement="top">
            <Typography variant="body2" color="text.secondary" noWrap>
              Base URL: {model.baseUrl}
            </Typography>
          </Tooltip>
        )}
      </CardContent>
      <CardActions disableSpacing>
        <Tooltip title="Test model (direct SDK call, no flow)" arrow>
          <IconButton aria-label="test" onClick={handleOpenTest}>
            <ScienceIcon />
          </IconButton>
        </Tooltip>
        <IconButton aria-label="edit" onClick={onEdit}>
          <EditIcon />
        </IconButton>
        <IconButton aria-label="delete" onClick={onDelete}>
          <DeleteIcon />
        </IconButton>
      </CardActions>

      <ModelTestDialog
        open={testOpen}
        modelLabel={model.displayName || model.name}
        loading={testLoading}
        result={testResult}
        error={testError}
        onClose={() => setTestOpen(false)}
        onRetry={runTest}
      />
    </Card>
  );
};

export default ModelCard;
