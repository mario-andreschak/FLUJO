'use client';

import { Box } from '@mui/material';
import ConversationChainGraph from '@/frontend/components/ConversationChainGraph';
import ClientOnly from '@/frontend/components/ClientOnly';

/** Chain Chat page (issue #405), view-only. */
export default function ChainChatPage() {
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ClientOnly>
        <ConversationChainGraph />
      </ClientOnly>
    </Box>
  );
}
