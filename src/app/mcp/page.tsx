'use client';

import { Box } from '@mui/material';
import MCPManager from '@/frontend/components/mcp';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/mcp/page');

export default function MCPPage() {
  log.debug('Rendering MCPPage');
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <MCPManager />
    </Box>
  );
}
