"use client";

import React from 'react';
import { Box, Typography, Container } from '@mui/material';
import Chat from '@/frontend/components/Chat';
import ClientOnly from '@/frontend/components/ClientOnly';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/chat/page');

export default function ChatPage() {
  log.debug('Rendering ChatPage');
  return (
    <Container maxWidth={false} disableGutters>
      <ClientOnly>
        <Chat />
      </ClientOnly>
    </Container>
  );
}
