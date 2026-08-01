import React from 'react';
import {
  Box,
  Typography,
  FormHelperText,
  Button
} from '@mui/material';
import CancelIcon from '@mui/icons-material/Cancel';
import { Model } from '../types';
import CardPickerGrid, { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';
import ModelCard from '@/frontend/components/models/list/ModelCard';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import { CardGroup } from '@/utils/shared/cardGrouping';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface ModelBindingProps {
  isLoadingModels: boolean;
  loadError: string | null;
  models: Model[];
  selectedModelId: string;
  handleModelSelect: (modelId: string) => void;
  isModelBound: boolean;
  handleUnbindModel: () => void;
}

const ModelBinding: React.FC<ModelBindingProps> = ({
  isLoadingModels,
  loadError,
  models,
  selectedModelId,
  handleModelSelect,
  isModelBound,
  handleUnbindModel
}) => {
  const { t } = useI18n();
  // Route the picker through the shared view-model (#92) so it mirrors the
  // Models page's saved search/sort/folder settings.
  const modelPicker = useCardPicker<Model>('models', models);
  const renderModelCard = (model: Model) => (
    <ModelCard
      model={model}
      selectable
      selected={selectedModelId === model.id}
      onSelect={handleModelSelect}
    />
  );
  const toModelCell = (model: Model): CardPickerItem => ({ key: model.id, content: renderModelCard(model) });
  const modelPickerItems: CardPickerItem[] = modelPicker.items.map(toModelCell);
  const modelPickerGroups: CardGroup<CardPickerItem>[] | null = modelPicker.groups
    ? modelPicker.groups.map((g) => ({ ...g, items: g.items.map(toModelCell) }))
    : null;

  return (
    <Box sx={{ mt: 4 }}>
      <Typography variant="subtitle1" gutterBottom>
        {t('flows.process.bindModel')}
      </Typography>

      {/* The model picker reuses the Models-page card layout (#92) so binding a
          model here looks exactly like the Models page. Cards act as a radio
          group: one selection at a time. */}
      <Box role="radiogroup" aria-label={t('flows.process.bindModelAria')}>
        <CardPickerGrid
          isLoading={isLoadingModels}
          error={loadError}
          loadingMessage={t('flows.process.loadingModels')}
          emptyMessage={t('flows.process.noModels')}
          searchable
          searchPlaceholder={t('flows.process.searchModels')}
          searchTerm={modelPicker.searchTerm}
          onSearchChange={modelPicker.setSearchTerm}
          columns={{ xs: 12, sm: 6 }}
          items={modelPickerItems}
          groups={modelPickerGroups}
          collapsedKeys={modelPicker.collapsedKeys}
          onToggleGroup={modelPicker.toggleGroup}
        />
      </Box>

      {!isLoadingModels && !loadError && models.length > 0 && (
        <>
          <FormHelperText>
            {selectedModelId
              ? t('flows.process.modelSelected')
              : t('flows.process.modelSelect')}
          </FormHelperText>

          {isModelBound && (
            <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                startIcon={<CancelIcon />}
                onClick={handleUnbindModel}
                color="primary"
                variant="outlined"
                size="small"
              >
                {t('flows.process.unbindModel')}
              </Button>
            </Box>
          )}
        </>
      )}
    </Box>
  );
};

export default ModelBinding;
