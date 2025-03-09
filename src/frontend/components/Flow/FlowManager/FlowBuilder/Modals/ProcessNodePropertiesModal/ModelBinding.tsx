import React from 'react';
import {
  Box,
  Typography,
  FormControl,
  RadioGroup,
  FormControlLabel,
  Radio,
  Grid,
  Paper,
  FormHelperText,
  Button
} from '@mui/material';
import CancelIcon from '@mui/icons-material/Cancel';
import { Model } from './types';

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

      {isLoadingModels ? (
        <Typography color="text.secondary">Loading models...</Typography>
      ) : loadError ? (
        <Typography color="error">{loadError}</Typography>
      ) : models.length === 0 ? (
        <Typography color="text.secondary">No models available. Add some in the Model Manager.</Typography>
      ) : (
        <>
          <FormControl component="fieldset" fullWidth>
            <RadioGroup
              value={selectedModelId}
              onChange={(e) => handleModelSelect(e.target.value)}
            >
              <Grid container spacing={2}>
                {models.map((model) => (
                  <Grid item xs={12} sm={6} key={model.id}>
                    <Paper
                      elevation={1}
                      sx={{
                        p: 2,
                        border: selectedModelId === model.id ? 2 : 0,
                        borderColor: 'primary.main',
                      }}
                    >
                      <FormControlLabel
                        value={model.id}
                        control={<Radio />}
                        label={
                          <Box>
                            <Typography variant="subtitle2">{model.displayName || model.name}</Typography>
                            {model.description && (
                              <Typography variant="caption" color="text.secondary" display="block">
                                {model.description}
                              </Typography>
                            )}
                            {model.baseUrl && (
                              <Typography variant="caption" color="text.secondary">
                                {model.baseUrl}
                              </Typography>
                            )}
                          </Box>
                        }
                        sx={{ width: '100%', m: 0 }}
                      />
                    </Paper>
                  </Grid>
                ))}
              </Grid>
            </RadioGroup>
            <FormHelperText>
              {selectedModelId ?
                `This node will use the selected model for processing.` :
                "Select a model to bind this node to."}
            </FormHelperText>
          </FormControl>

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
