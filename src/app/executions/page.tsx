'use client';

import { Box } from '@mui/material';
import PlannedExecutionsManager from '@/frontend/components/PlannedExecutions';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/executions/page');

export default function ExecutionsPage() {
  log.debug('Rendering ExecutionsPage');
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PlannedExecutionsManager />
    </Box>
  );
}
