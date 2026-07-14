"use client";

import React, { useState } from 'react';
import {
  Card,
  CardActionArea,
  CardContent,
  CardActions,
  Typography,
  IconButton,
  Box,
  Chip,
  Tooltip,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ScienceIcon from '@mui/icons-material/Science';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import { Model } from '@/shared/types';
import { getProviderProfile } from '@/shared/types/model/provider';
import { ModelTestResult } from '@/shared/types/model/response';
import { getModelService } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';
import ModelTestDialog from './ModelTestDialog';
import FolderAssignMenu from '@/frontend/components/shared/FolderAssignMenu';

const log = createLogger('frontend/components/models/list/ModelCard');

export interface ModelCardProps {
  model: Model;
  /** Optional in selectable/picker mode; required on the management page. */
  onEdit?: () => void;
  onDelete?: () => void;
  /** The model's current organizing folder (#80 / shared with #71). */
  folder?: string;
  /** Existing folders on the Models surface, offered for reuse in the picker. */
  folders?: string[];
  /** Assign/clear this model's folder. When omitted, the folder action is hidden. */
  onSetFolder?: (folder: string | undefined) => void;
  /**
   * When true, the card becomes a selectable picker cell (#92): the whole body
   * is clickable, the selected state is highlighted, and management actions
   * (test/edit/delete/folder) are hidden. Used by the Process node model
   * binding so the picker reuses the Models-page card verbatim.
   */
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (modelId: string) => void;
}

export const ModelCard = ({
  model,
  onEdit,
  onDelete,
  folder,
  folders = [],
  onSetFolder,
  selectable = false,
  selected = false,
  onSelect,
}: ModelCardProps) => {
  const [testOpen, setTestOpen] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [folderAnchorEl, setFolderAnchorEl] = useState<null | HTMLElement>(null);

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

  const body = (
    <>
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
        <Box sx={{ mb: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Provider: {getProviderProfile(model.provider, model.adapter).label}
          </Typography>
          {model.displayName && (
            <Typography variant="body2" color="text.secondary" noWrap>
              Model: {model.name}
            </Typography>
          )}
          {typeof model.contextWindow === 'number' && (
            <Typography variant="body2" color="text.secondary">
              Context: {model.contextWindow.toLocaleString()} tokens
            </Typography>
          )}
        </Box>
        {model.baseUrl && (
          <Tooltip title={model.baseUrl} arrow placement="top">
            <Typography variant="body2" color="text.secondary" noWrap>
              Base URL: {model.baseUrl}
            </Typography>
          </Tooltip>
        )}
        {folder && (
          <Chip
            icon={<FolderOutlinedIcon />}
            label={folder}
            size="small"
            variant="outlined"
            sx={{ mt: 1, maxWidth: '100%' }}
          />
        )}
      </CardContent>
    </>
  );

  // Selectable/picker mode (#92): the whole card is a single selection target,
  // management actions are suppressed, and the selected state is highlighted
  // with the same primary border used by FlowCard so pickers look consistent.
  if (selectable) {
    return (
      <Card
        elevation={selected ? 4 : 2}
        role="radio"
        aria-checked={selected}
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          border: (theme) => (selected ? `2px solid ${theme.palette.primary.main}` : '2px solid transparent'),
          transition: 'border-color 120ms, box-shadow 120ms',
        }}
      >
        <CardActionArea
          onClick={() => onSelect?.(model.id)}
          sx={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}
        >
          {body}
        </CardActionArea>
      </Card>
    );
  }

  return (
    <Card elevation={2} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {body}
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
        {onSetFolder && (
          <Tooltip title="Move to folder…" arrow>
            <IconButton
              aria-label="move to folder"
              onClick={(e) => setFolderAnchorEl(e.currentTarget)}
              sx={{ ml: 'auto' }}
            >
              <MoreVertIcon />
            </IconButton>
          </Tooltip>
        )}
      </CardActions>

      {onSetFolder && (
        <FolderAssignMenu
          anchorEl={folderAnchorEl}
          open={Boolean(folderAnchorEl)}
          currentFolder={folder}
          folders={folders}
          onClose={() => setFolderAnchorEl(null)}
          onAssign={onSetFolder}
        />
      )}

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
