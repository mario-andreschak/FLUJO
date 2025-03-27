import React from 'react';
import {
  Box,
  Typography,
  Divider,
  Chip,
  FormControlLabel,
  Switch,
  useMediaQuery,
  useTheme
} from '@mui/material';
import ApiIcon from '@mui/icons-material/Api';
import { version } from '../../../../../package.json';

interface SwaggerHeaderProps {
  useModernUI: boolean;
  setUseModernUI: (value: boolean) => void;
  enableModernUIToggle?: boolean;
}

/**
 * SwaggerHeader component displays the API documentation title and version
 * Can optionally include a toggle for switching between modern and traditional UI
 */
const SwaggerHeader: React.FC<SwaggerHeaderProps> = ({
  useModernUI,
  setUseModernUI,
  enableModernUIToggle = false
}) => {
  const theme = useTheme();
  const isSmallScreen = useMediaQuery(theme.breakpoints.down("md"));

  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          mb: 2,
          gap: 2,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <ApiIcon color="primary" fontSize="large" />
          <Typography variant="h4" component="h1">
            FLUJO API Documentation
          </Typography>
          <Chip
            label={`v${version}`}
            size="small"
            color="primary"
            variant="outlined"
            sx={{ ml: 1 }}
          />
        </Box>

        {enableModernUIToggle && (
          <FormControlLabel
            control={
              <Switch
                checked={useModernUI}
                onChange={(e) => setUseModernUI(e.target.checked)}
                color="primary"
              />
            }
            label="Use Modern UI"
          />
        )}
      </Box>
      <Divider sx={{ mb: 2 }} />
    </>
  );
};

export default SwaggerHeader; 