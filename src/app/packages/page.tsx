'use client';

import { useEffect } from 'react';
import { Box } from '@mui/material';
import { useRouter } from 'next/navigation';
import PackagesManager from '@/frontend/components/Packages';
import { useStorage } from '@/frontend/contexts/StorageContext';
import Spinner from '@/frontend/components/shared/Spinner';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/packages/page');

/**
 * Packages page (issue #194) — experimental. Behind `settings.experimental.enabled`
 * (#184), mirroring the Waves nav gate. Deep-linking here while the flag is off
 * redirects to Settings so the route can't be reached out-of-band.
 */
export default function PackagesPage() {
  const router = useRouter();
  const { settings, settingsHydrated } = useStorage();

  const experimentalEnabled = settingsHydrated && (settings?.experimental?.enabled ?? false);

  useEffect(() => {
    if (settingsHydrated && !experimentalEnabled) {
      log.debug('Experimental features disabled — redirecting away from /packages');
      router.replace('/settings');
    }
  }, [settingsHydrated, experimentalEnabled, router]);

  if (!settingsHydrated || !experimentalEnabled) {
    return <Spinner />;
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PackagesManager />
    </Box>
  );
}
