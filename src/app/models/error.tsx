'use client';

import { Box, Typography, Button } from '@mui/material';
import { useEffect } from 'react';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('app/models/error');

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    log.error('Error in models page:', { error: error.message, digest: error.digest });
  }, [error]);

  return (
    <Box 
      display="flex" 
      flexDirection="column" 
      alignItems="center" 
      justifyContent="center" 
      height="100%"
      p={4}
    >
      <Typography variant="h6" color="error" gutterBottom>
        {t('models.error.title')}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        {error.message || t('models.error.description')}
      </Typography>
      <Box sx={{ display: 'flex', gap: 2 }}>
        <Button 
          variant="contained" 
          onClick={reset}
        >
          {t('common.tryAgain')}
        </Button>
      </Box>
    </Box>
  );
}
