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
  alpha,
  useTheme,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ScienceIcon from '@mui/icons-material/Science';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import { Model } from '@/shared/types';
import { getProviderProfile } from '@/shared/types/model/provider';
import { ModelTestResult } from '@/shared/types/model/response';
import { getModelService } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';
import ModelTestDialog from './ModelTestDialog';
import FolderAssignMenu from '@/frontend/components/shared/FolderAssignMenu';
import { useI18n } from '@/frontend/contexts/I18nContext';

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
  /**
   * Toggle this model's favorite flag (#146, mirrors flows #120). When provided,
   * a star button is shown (top-left) on both the management and picker cards.
   */
  onToggleFavorite?: (modelId: string) => void;
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
  onToggleFavorite,
}: ModelCardProps) => {
  const { t, formatNumber } = useI18n();
  const theme = useTheme();
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
      setTestError(error instanceof Error ? error.message : t('models.test.failed'));
    } finally {
      setTestLoading(false);
    }
  };

  const handleOpenTest = () => {
    setTestOpen(true);
    runTest();
  };

  const handleFavoriteClick = (e: React.MouseEvent) => {
    // The card body is a click target (select in picker mode / test-dialog
    // trigger elsewhere) — don't let the star toggle bubble into it.
    e.stopPropagation();
    onToggleFavorite?.(model.id);
  };

  // Star overlay (#146): identical placement/styling to FlowCard's favorite star
  // (top-left, warning color when active). Shown whenever a toggle handler is
  // provided — on the management card and in picker mode alike.
  const favoriteButton = onToggleFavorite ? (
    <Tooltip title={model.favorite ? t('models.favorite.remove') : t('models.favorite.add')} arrow placement="top">
      <IconButton
        size="small"
        aria-label={model.favorite ? t('models.favorite.remove') : t('models.favorite.add')}
        onClick={handleFavoriteClick}
        sx={{
          position: 'absolute',
          top: 4,
          left: 4,
          zIndex: 2,
          color: model.favorite ? theme.palette.warning.main : theme.palette.text.secondary,
          backgroundColor: alpha(theme.palette.background.paper, 0.6),
          '&:hover': { backgroundColor: alpha(theme.palette.background.paper, 0.9) },
        }}
      >
        {model.favorite ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  ) : null;

  const body = (
    <>
      <CardContent sx={{ flexGrow: 1, p: 2.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1, mb: 1.2 }}>
          <Typography variant="h6" sx={{ pr: 1 }}>
            {model.displayName || model.name}
          </Typography>
          <Chip
            label={getProviderProfile(model.provider, model.adapter).label}
            size="small"
            sx={{
              flexShrink: 0,
              color: 'primary.light',
              bgcolor: alpha(theme.palette.primary.main, 0.09),
              border: `1px solid ${alpha(theme.palette.primary.main, 0.16)}`,
            }}
          />
        </Box>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mb: 2, minHeight: 42 }}
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
        <Box
          sx={{
            mb: 1,
            p: 1.25,
            border: 1,
            borderColor: 'divider',
            borderRadius: 2.5,
            bgcolor: alpha(theme.palette.background.default, 0.44),
          }}
        >
          {model.displayName && (
            <Typography variant="body2" color="text.secondary" noWrap>
              <Box component="span" sx={{ color: 'text.primary', fontWeight: 650 }}>{t('models.card.model')}</Box>
              {' · '}{model.name}
            </Typography>
          )}
          {typeof model.contextWindow === 'number' && (
            <Typography variant="body2" color="text.secondary">
              <Box component="span" sx={{ color: 'text.primary', fontWeight: 650 }}>{t('models.card.context')}</Box>
              {' · '}{formatNumber(model.contextWindow)} {t('models.card.tokens')}
            </Typography>
          )}
        </Box>
        {model.baseUrl && (
          <Tooltip title={model.baseUrl} arrow placement="top">
            <Typography variant="body2" color="text.secondary" noWrap>
              {t('models.card.baseUrl')}: {model.baseUrl}
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
        elevation={0}
        role="radio"
        aria-checked={selected}
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          border: (theme) => `1px solid ${selected ? theme.palette.primary.main : theme.palette.divider}`,
          boxShadow: selected ? `0 0 0 3px ${alpha(theme.palette.primary.main, 0.13)}` : undefined,
          transition: 'transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
          '&:hover': {
            borderColor: alpha(theme.palette.primary.main, 0.42),
            transform: 'translateY(-3px)',
          },
        }}
      >
        {favoriteButton}
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
    <Card
      elevation={0}
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        transition: 'transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease',
        '&:hover': {
          borderColor: alpha(theme.palette.primary.main, 0.38),
          boxShadow: `0 22px 60px ${alpha(theme.palette.primary.main, 0.12)}`,
          transform: 'translateY(-4px)',
        },
      }}
    >
      {favoriteButton}
      {body}
      <CardActions disableSpacing sx={{ px: 1.5, pb: 1.4, borderTop: 1, borderColor: 'divider' }}>
        <Tooltip title={t('models.card.testTooltip')} arrow>
          <IconButton aria-label={t('models.card.testAria')} onClick={handleOpenTest}>
            <ScienceIcon />
          </IconButton>
        </Tooltip>
        <IconButton aria-label={t('models.card.editAria')} onClick={onEdit}>
          <EditIcon />
        </IconButton>
        <IconButton aria-label={t('models.card.deleteAria')} onClick={onDelete}>
          <DeleteIcon />
        </IconButton>
        {onSetFolder && (
          <Tooltip title={t('models.card.moveTooltip')} arrow>
            <IconButton
              aria-label={t('models.card.moveAria')}
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
