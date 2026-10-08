'use client';

import React, { useId, useState } from 'react';
import Link from 'next/link';
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface JourneyServer {
  name: string;
  status: string;
  disabled?: boolean;
}

interface McpAgentJourneyProps {
  servers: JourneyServer[];
  onConnect: () => void;
  onInspect: (serverName: string) => void;
}

/** Navigation and instructions only; saving a connection is never a verified run. */
export default function McpAgentJourney({ servers, onConnect, onInspect }: McpAgentJourneyProps) {
  const { t } = useI18n();
  const guideId = useId();
  const [selectedName, setSelectedName] = useState('');
  const enabledServers = servers.filter((server) => !server.disabled);
  const selectedServer = enabledServers.find((server) => server.name === selectedName)
    ?? enabledServers.find((server) => server.status === 'connected')
    ?? enabledServers[0];

  return (
    <Accordion disableGutters sx={{ mx: { xs: 2, md: 3, lg: 4 }, mt: 2, borderRadius: 2 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} id={`${guideId}-summary`} aria-controls={`${guideId}-details`}>
        <Typography fontWeight={600}>{t('mcp.journey.title')}</Typography>
      </AccordionSummary>
      <AccordionDetails id={`${guideId}-details`}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t('mcp.journey.description')}</Typography>
        <Box component="ol" sx={{ m: 0, pl: 3, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, minmax(0, 1fr))' }, gap: 3 }}>
          <Box component="li" sx={{ minWidth: 0 }}>
            <Typography component="h3" variant="subtitle2">{t('mcp.journey.aiTitle')}</Typography>
            <Typography variant="body2" sx={{ my: 1 }}>{t('mcp.journey.aiBody')}</Typography>
            <Button component={Link} href="/models" variant="outlined">{t('nav.aiSetup')}</Button>
          </Box>
          <Box component="li" sx={{ minWidth: 0 }}>
            <Typography component="h3" variant="subtitle2">{t('mcp.journey.appTitle')}</Typography>
            <Typography variant="body2" sx={{ my: 1 }}>{t('mcp.journey.appBody')}</Typography>
            <Stack spacing={1} alignItems="flex-start">
              <Button onClick={onConnect} variant="outlined">{t('mcp.server.connectApp')}</Button>
              {enabledServers.length > 0 && (
                <TextField select fullWidth size="small" label={t('mcp.journey.savedApp')} value={selectedServer?.name ?? ''}
                  onChange={(event) => setSelectedName(event.target.value)}>
                  {enabledServers.map((server) => <MenuItem key={server.name} value={server.name}>{server.name}</MenuItem>)}
                </TextField>
              )}
              <Typography variant="caption" color="text.secondary" role="status">
                {!selectedServer ? t('mcp.journey.noApp')
                  : selectedServer.status === 'connected' ? t('mcp.journey.connected') : t('mcp.journey.unverified')}
              </Typography>
              <Button onClick={() => selectedServer && onInspect(selectedServer.name)} disabled={!selectedServer} variant="outlined">
                {t('mcp.journey.inspect')}
              </Button>
            </Stack>
          </Box>
          <Box component="li" sx={{ minWidth: 0 }}>
            <Typography component="h3" variant="subtitle2">{t('mcp.journey.agentTitle')}</Typography>
            <Typography variant="body2" sx={{ my: 1 }}>{t('mcp.journey.agentBody')}</Typography>
            <Button component={Link} href="/flows?authoringMode=guided" variant="outlined">{t('nav.agents')}</Button>
          </Box>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>{t('mcp.journey.next')}</Typography>
        <Button component={Link} href="/docs" size="small" sx={{ mt: 1 }}>{t('nav.help')}</Button>
      </AccordionDetails>
    </Accordion>
  );
}
