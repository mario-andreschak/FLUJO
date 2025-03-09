"use client";

import React from 'react';
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
import { Model } from '@/frontend/contexts';

export interface ModelCardProps {
  model: Model;
  onEdit: () => void;
  onDelete: () => void;
}

export const ModelCard = ({ model, onEdit, onDelete }: ModelCardProps) => {
  return (
    <Card elevation={2}>
      <CardContent>
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
        <IconButton aria-label="edit" onClick={onEdit}>
          <EditIcon />
        </IconButton>
        <IconButton aria-label="delete" onClick={onDelete}>
          <DeleteIcon />
        </IconButton>
      </CardActions>
    </Card>
  );
};

export default ModelCard;
