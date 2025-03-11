"use client";

import { Box } from '@mui/material';
import Settings from '@/frontend/components/Settings';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/settings/page');

export default function SettingsPage() {
  log.debug('Rendering SettingsPage');
  return (
    <Box component="main" sx={{ minHeight: '100vh' }}>
      <Settings />
    </Box>
  );
}
