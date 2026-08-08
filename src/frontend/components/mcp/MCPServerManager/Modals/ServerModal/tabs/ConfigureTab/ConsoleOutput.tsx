'use client';

import React from 'react';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { 
  Box, 
  IconButton, 
  Paper, 
  Typography,
  useTheme
} from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface ConsoleOutputProps {
  output: string;
  isVisible: boolean;
  toggleVisibility: () => void;
  title?: string;
}

const ConsoleOutput: React.FC<ConsoleOutputProps> = ({
  output,
  isVisible,
  toggleVisibility,
  title
}) => {
  const theme = useTheme();
  const { t } = useI18n();
  
  return (
    <Paper 
      variant="outlined" 
      sx={{ 
        p: 2, 
        height: '100%',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">{title ?? t('mcp.local.console.output')}</Typography>
        <IconButton
          onClick={toggleVisibility}
          size="small"
          title={isVisible ? t('mcp.local.console.hide') : t('mcp.local.console.show')}
          color="inherit"
          sx={{ color: 'text.secondary' }}
        >
          {isVisible ? <VisibilityOffIcon /> : <VisibilityIcon />}
        </IconButton>
      </Box>
      
      <Box 
        sx={{ 
          fontFamily: 'monospace',
          p: 2,
          borderRadius: 1,
          bgcolor: theme.palette.mode === 'dark' ? '#121212' : '#1a1a1a',
          color: '#4ade80',
          flex: 1,
          overflow: 'auto'
        }}
      >
        {output ? (
          <Box component="pre" sx={{ whiteSpace: 'pre-wrap', m: 0 }}>
            {output}
          </Box>
        ) : (
          <Typography variant="body2" sx={{ fontStyle: 'italic', color: 'text.secondary' }}>
            {t('mcp.local.console.empty')}
          </Typography>
        )}
      </Box>
    </Paper>
  );
};

export default ConsoleOutput;
