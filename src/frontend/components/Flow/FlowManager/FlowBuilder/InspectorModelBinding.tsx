"use client";

import React, { useMemo, useState } from 'react';
import {
  Box,
  ButtonBase,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import SmartToyRoundedIcon from '@mui/icons-material/SmartToyRounded';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import type { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import ModelCard from '@/frontend/components/models/list/ModelCard';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import type { CardGroup } from '@/utils/shared/cardGrouping';
import type { Model } from '@/shared/types';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface InspectorModelBindingProps {
  models: Model[];
  selectedModelId?: string;
  beginnerMode?: boolean;
  onSelect: (modelId: string) => void;
  onRemove: () => void;
}

const InspectorModelBinding: React.FC<InspectorModelBindingProps> = ({
  models,
  selectedModelId,
  beginnerMode = false,
  onSelect,
  onRemove,
}) => {
  const { t } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);
  const modelPicker = useCardPicker<Model>('models', models);
  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId),
    [models, selectedModelId],
  );
  const selectedLabel = selectedModel?.displayName || selectedModel?.name || selectedModelId;

  const pickModel = (modelId: string) => {
    onSelect(modelId);
    setPickerOpen(false);
  };

  const toModelCell = (model: Model): CardPickerItem => ({
    key: model.id,
    content: beginnerMode ? (
      <ButtonBase
        onClick={() => pickModel(model.id)}
        sx={(theme) => ({
          width: '100%',
          minHeight: 74,
          px: 1.5,
          py: 1.25,
          justifyContent: 'flex-start',
          textAlign: 'left',
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 2.5,
          transition: theme.transitions.create(['border-color', 'background-color']),
          '&:hover': {
            borderColor: 'primary.main',
            backgroundColor: 'action.hover',
          },
        })}
      >
        <SmartToyRoundedIcon color="primary" sx={{ mr: 1.25 }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={800} noWrap>
            {model.displayName || model.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('flows.inspector.simpleModelHelp')}
          </Typography>
        </Box>
      </ButtonBase>
    ) : (
      <ModelCard
        model={model}
        selectable
        selected={selectedModelId === model.id}
        onSelect={pickModel}
      />
    ),
  });
  const pickerItems = modelPicker.items.map(toModelCell);
  const pickerGroups: CardGroup<CardPickerItem>[] | null = modelPicker.groups
    ? modelPicker.groups.map((group) => ({ ...group, items: group.items.map(toModelCell) }))
    : null;
  const heading = beginnerMode
    ? t('flows.inspector.stepAi')
    : t('flows.inspector.boundModel');
  const chooseLabel = beginnerMode
    ? t('flows.inspector.chooseAi')
    : t('flows.inspector.chooseModel');

  return (
    <Box
      sx={(theme) => ({
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 2.5,
        overflow: 'hidden',
      })}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1.25, py: 0.75 }}>
        <Typography variant="caption" fontWeight={800}>
          {heading}
        </Typography>
        <Tooltip title={chooseLabel}>
          <IconButton
            size="small"
            aria-label={chooseLabel}
            onClick={() => setPickerOpen(true)}
          >
            <AddRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {!selectedModelId ? (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ px: 1.25, pb: 1.25 }}>
          {beginnerMode ? t('flows.inspector.noStepAi') : t('flows.inspector.noBoundModel')}
        </Typography>
      ) : (
        <Stack
          direction="row"
          alignItems="center"
          gap={0.75}
          sx={{ minHeight: 42, px: 1, borderTop: 1, borderColor: 'divider' }}
        >
          <SmartToyRoundedIcon color="primary" sx={{ fontSize: 17 }} />
          <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {selectedLabel}
          </Typography>
          <Tooltip title={t('flows.inspector.removeModel', { model: selectedLabel ?? selectedModelId })}>
            <IconButton
              size="small"
              color="error"
              aria-label={t('flows.inspector.removeModel', { model: selectedLabel ?? selectedModelId })}
              onClick={onRemove}
            >
              <DeleteOutlineRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      )}

      <CardPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        ariaLabel={beginnerMode ? t('flows.inspector.aiPickerAria') : t('flows.inspector.modelPickerAria')}
        isLoading={false}
        emptyMessage={t('flows.process.noModels')}
        searchable
        searchPlaceholder={t('flows.process.searchModels')}
        searchTerm={modelPicker.searchTerm}
        onSearchChange={modelPicker.setSearchTerm}
        columns={{ xs: 12, sm: 6 }}
        items={pickerItems}
        groups={pickerGroups}
        collapsedKeys={modelPicker.collapsedKeys}
        onToggleGroup={modelPicker.toggleGroup}
      />
    </Box>
  );
};

export default InspectorModelBinding;
