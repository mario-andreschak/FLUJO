"use client";

import { use } from 'react';
import { Box } from '@mui/material';
import Settings from '@/frontend/components/Settings';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/settings/page');

export default function SettingsPage({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  log.debug('Rendering SettingsPage');
  const { section } = use(searchParams);
  return (
    <Box component="div" sx={{ minHeight: '100%' }}>
      <Settings initialSection={typeof section === 'string' ? section : undefined} />
    </Box>
  );
}
