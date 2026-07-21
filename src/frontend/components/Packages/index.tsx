'use client';

import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import PackageWizard from './PackageWizard';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Packages');

/**
 * Packages page manager (issue #194). Hosts the "Create package" wizard entry
 * point. Listing/managing already-built packages is a separate concern (the
 * registry/install issues own persistence); this page focuses on assembling a
 * shareable package from existing entities and exporting it.
 */
export default function PackagesManager() {
  const [wizardOpen, setWizardOpen] = useState(false);

  log.debug('Rendering PackagesManager', { wizardOpen });

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          p: 2,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="h5">Packages</Typography>
          <Chip label="experimental" size="small" color="warning" variant="outlined" />
        </Stack>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setWizardOpen(true)}
          data-tour="packages-create"
        >
          Create package
        </Button>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
        <Paper
          variant="outlined"
          sx={{
            p: 4,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 2,
            maxWidth: 640,
            mx: 'auto',
          }}
        >
          <Inventory2OutlinedIcon sx={{ fontSize: 48, color: 'text.secondary' }} />
          <Typography variant="h6">Bundle your FLUJO setup into a shareable package</Typography>
          <Typography variant="body2" color="text.secondary">
            A package bundles flows, models, MCP servers (by reference) and planned
            executions into a single manifest you can export and share. Secret values
            (API keys, tokens) are never included — only declarations of the secrets a
            recipient must supply at install time.
          </Typography>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setWizardOpen(true)}>
            Create package
          </Button>
        </Paper>
      </Box>

      {wizardOpen && <PackageWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />}
    </Box>
  );
}
