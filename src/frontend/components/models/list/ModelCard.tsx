"use client";

import React, { useState } from 'react';
import {
  Card,
  CardActionArea,
  CardContent,
  CardActions,
  Checkbox,
  Radio,
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
import MemoryOutlinedIcon from '@mui/icons-material/MemoryOutlined';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import { Model } from '@/shared/types';
import { getProviderProfile } from '@/shared/types/model/provider';
import { ModelTestResult } from '@/shared/types/model/response';
import { getModelService } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';
import ModelTestDialog from './ModelTestDialog';
import FolderAssignMenu from '@/frontend/components/shared/FolderAssignMenu';
import CopyLinkButton from '@/frontend/components/shared/CopyLinkButton';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useThemeUtils } from '@/frontend/utils/theme';
import type { SxProps, Theme } from '@mui/material/styles';

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
  /** Visual and accessibility semantics for one- or many-model selection. */
  selectionMode?: 'single' | 'multiple';
  /** Disabled models stay visible without accepting selection. */
  disabled?: boolean;
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
  selectionMode = 'single',
  disabled = false,
  onToggleFavorite,
}: ModelCardProps) => {
  const { t, formatNumber } = useI18n();
  const theme = useTheme();
  const { visualStyle } = useThemeUtils();
  const modern = visualStyle === 'modern';
  const providerProfile = getProviderProfile(model.provider, model.adapter);
  const providerMark = (providerProfile.label.match(/[a-z0-9]+/gi) ?? [])
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
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

  // Star overlay (#146): the modern utility-card header keeps it on the quiet
  // top-right edge; legacy retains the original top-left placement.
  const favoriteButton = onToggleFavorite ? (
    <Tooltip title={model.favorite ? t('models.favorite.remove') : t('models.favorite.add')} arrow placement="top">
      <IconButton
        size="small"
        aria-label={model.favorite ? t('models.favorite.remove') : t('models.favorite.add')}
        onClick={handleFavoriteClick}
        sx={{
          position: 'absolute',
          top: modern ? 10 : 4,
          left: modern ? undefined : 4,
          right: modern ? 10 : undefined,
          zIndex: 2,
          color: model.favorite ? theme.palette.warning.main : theme.palette.text.secondary,
          backgroundColor: alpha(theme.palette.background.paper, modern ? 0.72 : 0.6),
          backdropFilter: modern ? 'blur(10px)' : undefined,
          '&:hover': { backgroundColor: alpha(theme.palette.background.paper, 0.9) },
        }}
      >
        {model.favorite ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  ) : null;

  const body = modern ? (
    <CardContent sx={{ flexGrow: 1, p: 2, pb: 1.5, '&:last-child': { pb: 1.5 } }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.35,
          minWidth: 0,
          mb: 1.35,
          pr: onToggleFavorite ? 4.5 : 0,
        }}
      >
        <Box
          aria-hidden="true"
          sx={{
            width: 48,
            height: 48,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 3,
            color: 'primary.main',
            background: `linear-gradient(145deg, ${alpha(theme.palette.primary.main, 0.18)}, ${alpha(theme.palette.secondary.main, 0.11)})`,
            border: `1px solid ${alpha(theme.palette.primary.main, 0.18)}`,
            boxShadow: `inset 0 1px 0 ${alpha(theme.palette.common.white, theme.palette.mode === 'dark' ? 0.08 : 0.55)}`,
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
            {providerMark}
          </Typography>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" component="h3" noWrap title={model.displayName || model.name}>
            {model.displayName || model.name}
          </Typography>
          {model.displayName && (
            <Typography variant="caption" color="text.secondary" component="div" noWrap title={model.name}>
              {model.name}
            </Typography>
          )}
          <Chip
            label={providerProfile.label}
            size="small"
            sx={{
              mt: 0.45,
              height: 21,
              color: 'primary.main',
              bgcolor: alpha(theme.palette.primary.main, 0.08),
              border: `1px solid ${alpha(theme.palette.primary.main, 0.13)}`,
              '& .MuiChip-label': { px: 0.85, fontSize: '0.68rem', fontWeight: 700 },
            }}
          />
        </Box>
      </Box>

      {model.description && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            mb: 1.35,
            minHeight: 38,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {model.description}
        </Typography>
      )}

      {(typeof model.contextWindow === 'number' || model.baseUrl) && (
        <Box
          sx={{
            mt: 'auto',
            display: 'grid',
            overflow: 'hidden',
            borderRadius: 3,
            border: `1px solid ${alpha(theme.palette.primary.main, 0.12)}`,
            bgcolor: alpha(theme.palette.background.default, theme.palette.mode === 'dark' ? 0.38 : 0.34),
          }}
        >
          {typeof model.contextWindow === 'number' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8, minWidth: 0, px: 1.15, py: 0.8 }}>
              <Box
                sx={{
                  width: 28,
                  height: 28,
                  flexShrink: 0,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: 2,
                  color: 'primary.main',
                  bgcolor: alpha(theme.palette.primary.main, 0.1),
                }}
              >
                <MemoryOutlinedIcon sx={{ fontSize: 17 }} />
              </Box>
              <Typography variant="caption" noWrap sx={{ flex: 1, minWidth: 0, color: 'text.secondary' }}>
                <Box component="span" sx={{ color: 'text.primary', fontWeight: 650 }}>
                  {t('models.card.context')}
                </Box>
                {' · '}{formatNumber(model.contextWindow)} {t('models.card.tokens')}
              </Typography>
            </Box>
          )}

          {model.baseUrl && (
            <Tooltip title={model.baseUrl} arrow placement="top">
              <Typography
                variant="caption"
                noWrap
                sx={{
                  minWidth: 0,
                  px: 1.2,
                  py: 0.7,
                  color: 'text.secondary',
                  borderTop: typeof model.contextWindow === 'number'
                    ? `1px solid ${alpha(theme.palette.divider, 0.75)}`
                    : undefined,
                  bgcolor: alpha(theme.palette.background.paper, 0.3),
                }}
              >
                {model.baseUrl}
              </Typography>
            </Tooltip>
          )}
        </Box>
      )}

      {folder && (
        <Chip
          icon={<FolderOutlinedIcon />}
          label={folder}
          size="small"
          variant="outlined"
          sx={{ mt: 1, maxWidth: '100%', height: 24, color: 'text.secondary' }}
        />
      )}
    </CardContent>
  ) : (
    <>
      <CardContent sx={{ flexGrow: 1, p: 2.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1, mb: 1.2 }}>
          <Typography variant="h6" sx={{ pr: 1 }}>
            {model.displayName || model.name}
          </Typography>
          <Chip
            label={providerProfile.label}
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

  const modernCardSx = (highlighted = false): SxProps<Theme> => ({
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    overflow: 'hidden',
    borderRadius: '18px',
    border: `1px solid ${highlighted
      ? theme.palette.primary.main
      : alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.14)}`,
    background: `linear-gradient(145deg, ${alpha(theme.palette.background.paper, theme.palette.mode === 'dark' ? 0.78 : 0.82)}, ${alpha(theme.palette.background.paper, theme.palette.mode === 'dark' ? 0.62 : 0.68)} 62%, ${alpha(theme.palette.primary.main, 0.055)})`,
    backdropFilter: 'blur(18px) saturate(135%)',
    WebkitBackdropFilter: 'blur(18px) saturate(135%)',
    boxShadow: highlighted
      ? `0 0 0 3px ${alpha(theme.palette.primary.main, 0.13)}`
      : `0 16px 45px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.2 : 0.07)}`,
    transition: 'transform 220ms cubic-bezier(0.2, 0.75, 0.2, 1), box-shadow 220ms ease, border-color 180ms ease',
    '&::before': {
      content: '""',
      position: 'absolute',
      inset: '0 0 auto 0',
      height: 2,
      zIndex: 1,
      background: `linear-gradient(90deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main}, transparent 82%)`,
      opacity: highlighted ? 1 : 0.68,
    },
    '&:hover': {
      borderColor: alpha(theme.palette.primary.main, 0.38),
      boxShadow: `0 24px 64px ${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.13)}`,
      transform: 'translateY(-4px)',
    },
  });

  // Selectable/picker mode (#92): the whole card is a single selection target,
  // management actions are suppressed, and the selected state is highlighted
  // with the same primary border used by FlowCard so pickers look consistent.
  if (selectable) {
    return (
      <Card
        elevation={0}
        role={selectionMode === 'multiple' ? 'checkbox' : 'radio'}
        aria-checked={selected}
        aria-disabled={disabled || undefined}
        sx={modern ? [modernCardSx(selected), { opacity: disabled ? 0.58 : 1 }] : {
            height: '100%',
            display: 'flex',
            opacity: disabled ? 0.58 : 1,
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
        <Box sx={{ position: 'absolute', top: 6, left: 6, zIndex: 2, pointerEvents: 'none' }}>
          {selectionMode === 'multiple'
            ? <Checkbox checked={selected} disabled={disabled} tabIndex={-1} />
            : <Radio checked={selected} disabled={disabled} tabIndex={-1} />}
        </Box>
        {favoriteButton}
        <CardActionArea
          disabled={disabled}
          onClick={() => !disabled && onSelect?.(model.id)}
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
      sx={modern ? modernCardSx() : {
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
      {modern ? (
        <CardActions
          disableSpacing
          sx={{
            px: 1.5,
            py: 0.75,
            borderTop: `1px solid ${alpha(theme.palette.divider, 0.72)}`,
            bgcolor: alpha(theme.palette.background.paper, 0.28),
          }}
        >
          <Tooltip title={t('models.card.testTooltip')} arrow>
            <IconButton
              size="small"
              aria-label={t('models.card.testAria')}
              onClick={handleOpenTest}
              sx={{ color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
            >
              <ScienceIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.15 }}>
            {onSetFolder && (
              <Tooltip title={t('models.card.moveTooltip')} arrow>
                <IconButton
                  size="small"
                  aria-label={t('models.card.moveAria')}
                  onClick={(e) => setFolderAnchorEl(e.currentTarget)}
                  sx={{ color: folder ? 'primary.main' : 'text.secondary', '&:hover': { color: 'primary.main' } }}
                >
                  <MoreVertIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <CopyLinkButton target={{ kind: 'model', id: model.id }} size="small" sx={{ color: 'text.secondary' }} />
            <Tooltip title={t('models.card.editAria')} arrow>
              <IconButton
                size="small"
                aria-label={t('models.card.editAria')}
                onClick={onEdit}
                sx={{ color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
              >
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t('models.card.deleteAria')} arrow>
              <IconButton
                size="small"
                aria-label={t('models.card.deleteAria')}
                onClick={onDelete}
                sx={{
                  color: 'text.secondary',
                  '&:hover': {
                    color: 'error.main',
                    bgcolor: alpha(theme.palette.error.main, 0.08),
                  },
                }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        </CardActions>
      ) : (
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
          <CopyLinkButton target={{ kind: 'model', id: model.id }} />
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
      )}

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
