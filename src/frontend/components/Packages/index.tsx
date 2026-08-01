'use client';

import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Paper,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import PackageWizard from './PackageWizard';
import InstalledPackagesList from './InstalledPackagesList';
import InstallPackageCard from './InstallPackageCard';
import RegistryAccountSettings from './RegistryAccountSettings';
import PageHeader from '@/frontend/components/shared/PageHeader';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/Packages');

/**
 * Packages page manager (issue #194). Hosts the "Create package" wizard entry
 * point. Listing/managing already-built packages is a separate concern (the
 * registry/install issues own persistence); this page focuses on assembling a
 * shareable package from existing entities and exporting it.
 */
export default function PackagesManager() {
  const { t } = useI18n();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [installedRefreshKey, setInstalledRefreshKey] = useState(0);

  log.debug('Rendering PackagesManager', { wizardOpen });

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PageHeader
        eyebrowKey="packages.page.eyebrow"
        titleKey="packages.page.title"
        descriptionKey="packages.page.description"
        icon={Inventory2OutlinedIcon}
        badge={<Chip label={t('packages.page.experimental')} size="small" color="warning" variant="outlined" />}
        actions={(
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setWizardOpen(true)}
            data-tour="packages-create"
          >
            {t('packages.page.create')}
          </Button>
        )}
      />

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
            maxWidth: { xs: '100%', md: 1100 },
            mx: 'auto',
          }}
        >
          <Inventory2OutlinedIcon sx={{ fontSize: 48, color: 'text.secondary' }} />
          <Typography variant="h6">{t('packages.page.hero')}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t('packages.page.heroHelp')}
          </Typography>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setWizardOpen(true)}>
            {t('packages.page.create')}
          </Button>
        </Paper>

        <Paper
          variant="outlined"
          sx={{
            p: 3,
            mt: 3,
            maxWidth: { xs: '100%', md: 1100 },
            mx: 'auto',
          }}
        >
          <Typography variant="h6" gutterBottom>
            {t('packages.page.account')}
          </Typography>
          <RegistryAccountSettings />
        </Paper>

        <InstallPackageCard onInstalled={() => setInstalledRefreshKey((k) => k + 1)} />

        <InstalledPackagesList key={installedRefreshKey} />
      </Box>

      {wizardOpen && <PackageWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />}
    </Box>
  );
}
