'use client';

import { Box, Typography, Button } from '@mui/material';
import { useEffect } from 'react';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/models/error');

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
        Error loading models
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        {error.message || 'Something went wrong while loading the models.'}
      </Typography>
      <Box sx={{ display: 'flex', gap: 2 }}>
        <Button 
          variant="contained" 
          onClick={reset}
        >
          Try again
        </Button>
      </Box>
    </Box>
  );
}
