'use client';

import { useEffect } from 'react';
import { Box } from '@mui/material';
import { useRouter } from 'next/navigation';
import ConversationChainGraph from '@/frontend/components/ConversationChainGraph';
import ClientOnly from '@/frontend/components/ClientOnly';
import { useStorage } from '@/frontend/contexts/StorageContext';
import Spinner from '@/frontend/components/shared/Spinner';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/chain-chat/page');

/**
 * Chain Chat page (issue #405) — experimental and view-only. Gated behind
 * `settings.experimental.enabled` exactly like /packages, so deep-linking here
 * while the flag is off redirects to Settings instead of exposing the route
 * out-of-band.
 */
export default function ChainChatPage() {
  const router = useRouter();
  const { settings, settingsHydrated } = useStorage();

  const experimentalEnabled = settingsHydrated && (settings?.experimental?.enabled ?? false);

  useEffect(() => {
    if (settingsHydrated && !experimentalEnabled) {
      log.debug('Experimental features disabled — redirecting away from /chain-chat');
      router.replace('/settings');
    }
  }, [settingsHydrated, experimentalEnabled, router]);

  if (!settingsHydrated || !experimentalEnabled) {
    return <Spinner />;
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ClientOnly>
        <ConversationChainGraph />
      </ClientOnly>
    </Box>
  );
}
