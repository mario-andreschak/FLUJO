"use client";

import { Box } from '@mui/material';
import Docs from '@/frontend/components/Docs';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/docs/page');

export default function DocsPage() {
  log.debug('Rendering DocsPage');
  return (
    <Box component="main" sx={{ minHeight: '100vh' }}>
      <Docs />
    </Box>
  );
}
