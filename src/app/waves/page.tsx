'use client';

import { Box } from '@mui/material';
import WavesManager from '@/frontend/components/Waves';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/waves/page');

export default function WavesPage() {
  log.debug('Rendering WavesPage');
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <WavesManager />
    </Box>
  );
}
