'use client';

import { useEffect } from 'react';
import { Box } from '@mui/material';
import { useRouter } from 'next/navigation';
import Statistics from '@/frontend/components/Statistics';
import Spinner from '@/frontend/components/shared/Spinner';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/statistics/page');

/** Experimental analytics dashboard with the same deep-link guard as Packages. */
export default function StatisticsPage() {
  const router = useRouter();
  const { settings, settingsHydrated } = useStorage();
  const experimentalEnabled =
    settingsHydrated && (settings?.experimental?.enabled ?? false);

  useEffect(() => {
    if (settingsHydrated && !experimentalEnabled) {
      log.debug('Experimental features disabled — redirecting away from /statistics');
      router.replace('/settings');
    }
  }, [settingsHydrated, experimentalEnabled, router]);

  if (!settingsHydrated || !experimentalEnabled) {
    return <Spinner />;
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Statistics />
    </Box>
  );
}
