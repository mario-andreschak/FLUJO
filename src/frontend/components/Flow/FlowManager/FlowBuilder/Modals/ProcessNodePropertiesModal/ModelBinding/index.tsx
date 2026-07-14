import React from 'react';
import {
  Box,
  Typography,
  FormHelperText,
  Button
} from '@mui/material';
import CancelIcon from '@mui/icons-material/Cancel';
import { Model } from '../types';
import CardPickerGrid from '@/frontend/components/shared/CardPickerGrid';
import ModelCard from '@/frontend/components/models/list/ModelCard';

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
  return (
    <Box sx={{ mt: 4 }}>
      <Typography variant="subtitle1" gutterBottom>
        Bind to Model
      </Typography>

      {/* The model picker reuses the Models-page card layout (#92) so binding a
          model here looks exactly like the Models page. Cards act as a radio
          group: one selection at a time. */}
      <Box role="radiogroup" aria-label="Bind to model">
        <CardPickerGrid
          isLoading={isLoadingModels}
          error={loadError}
          loadingMessage="Loading models..."
          emptyMessage="No models available. Add some in the Model Manager."
          columns={{ xs: 12, sm: 6 }}
          items={models.map((model) => ({
            key: model.id,
            content: (
              <ModelCard
                model={model}
                selectable
                selected={selectedModelId === model.id}
                onSelect={handleModelSelect}
              />
            ),
          }))}
        />
      </Box>

      {!isLoadingModels && !loadError && models.length > 0 && (
        <>
          <FormHelperText>
            {selectedModelId
              ? `This node will use the selected model for processing.`
              : 'Select a model to bind this node to.'}
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
                Unbind Model
              </Button>
            </Box>
          )}
        </>
      )}
    </Box>
  );
};

export default ModelBinding;
