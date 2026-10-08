'use client';

import React, { useState, useEffect } from 'react';
import { ServerModalProps, type ServerSetupTab, type TabHandoff } from './types';
import { MCPServerConfig } from '@/utils/mcp/';
import GitHubTab from './tabs/GitHubTab';
import ConfigureTab from './tabs/ConfigureTab';
import MarketplaceTab from './tabs/MarketplaceTab';
import SpotlightTab from './tabs/SpotlightTab';
import ReferenceServersTab from './tabs/ReferenceServersTab';
import RemoteTab from './tabs/RemoteTab';
import { useThemeUtils } from '@/frontend/utils/theme';
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  Tabs,
  Tab,
  Box,
  useMediaQuery,
  useTheme
} from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';

const ServerModal: React.FC<ServerModalProps> = ({
  isOpen,
  onClose,
  onAdd,
  initialConfig,
  initialTab = 'spotlight',
  onUpdate,
  onRestartAfterUpdate,
  onSaveAndAuthenticate
}) => {
  const { t } = useI18n();
  const theme = useTheme();
  // Phones get the whole viewport: the desktop 95vw shell leaves the six setup
  // tabs and the configure form unusable at phone widths (#394).
  const isPhoneLayout = useMediaQuery(theme.breakpoints.down('sm'), { noSsr: true });
  const [activeTab, setActiveTab] = useState<ServerSetupTab>(initialTab);
  
  // The single source→sink message (#392). Every inbound tab prop below is
  // derived from it, so adding a new handoff never adds a prop to all six tabs.
  const [handoff, setHandoff] = useState<TabHandoff | null>(null);
  // Bumped on every handoff so the configure tab can re-arm its auto-run guard:
  // installing the same server twice in a row must test-run both times.
  const [handoffId, setHandoffId] = useState<number>(0);

  const parsedConfig: MCPServerConfig | null = handoff?.to === 'configure' ? handoff.config : null;
  const autoTestRun = handoff?.to === 'configure' && Boolean(handoff.autoTestRun);
  const githubPrefillUrl = handoff?.to === 'github' ? handoff.repoUrl : '';

  const handleHandoff = (next: TabHandoff) => {
    setHandoff(next);
    setHandoffId(id => id + 1);
    setActiveTab(next.to === 'github' ? 'github' : 'configure');
  };
  
  // Track which tabs have been visited/initialized
  const [initializedTabs, setInitializedTabs] = useState<{
    spotlight: boolean;
    marketplace: boolean;
    github: boolean;
    configure: boolean;
    reference: boolean;
    remote: boolean;
  }>({
    spotlight: false,
    marketplace: false,
    github: false,
    configure: false,
    reference: false,
    remote: false
  });

  // Initialize fields only on first visit to each tab in add mode
  useEffect(() => {
    if (!initialConfig && !initializedTabs[activeTab]) {
      // Mark this tab as visited
      setInitializedTabs(prev => ({ ...prev, [activeTab]: true }));
    }
  }, [activeTab, initialConfig, initializedTabs]);

  // Each wizard route opens the existing setup experience at the relevant
  // destination. Re-apply it on open so a previous visit never leaks through.
  useEffect(() => {
    if (isOpen && !initialConfig) setActiveTab(initialTab);
  }, [initialConfig, initialTab, isOpen]);

  const { getThemeValue } = useThemeUtils();
  
  const handleTabChange = (event: React.SyntheticEvent, newValue: ServerSetupTab) => {
    // A manual tab change is not a handoff — don't re-trigger the auto run or
    // keep a stale GitHub-URL prefill around. The configured draft itself is
    // deliberately kept, so switching tabs never discards work in progress.
    setHandoff(prev => {
      if (!prev) return prev;
      if (prev.to === 'github') return null;
      return prev.autoTestRun ? { ...prev, autoTestRun: false } : prev;
    });
    setActiveTab(newValue);
  };

  // Handle close with state reset
  const handleClose = () => {
    // Drop the handoff (and with it the parsed config / auto-run / prefill)
    setHandoff(null);
    // Reset to default tab
    setActiveTab('spotlight');
    // Call the original onClose
    onClose();
  };

  return (
    <Dialog 
      open={isOpen} 
      onClose={handleClose}
      maxWidth="xl"
      fullWidth
      fullScreen={isPhoneLayout}
      PaperProps={{
        // The desktop sizing must not fight `fullScreen`, so it is only applied
        // above the phone breakpoint.
        sx: isPhoneLayout
          ? {
              width: '100%',
              maxWidth: '100%',
              height: '100%',
              maxHeight: '100%',
              m: 0,
            }
          : {
              width: '95vw',
              maxWidth: '95vw',
              maxHeight: '95vh',
              height: 'auto',
            }
      }}
    >
      <DialogHeaderActions
        title={initialConfig
          ? t('mcp.modal.editTitle', { name: initialConfig.name })
          : t('mcp.modal.addTitle')}
        onClose={handleClose}
      />

      <DialogContent sx={{ p: 0 }}>
        {/* Only show tabs in creation mode, not in edit mode */}
        {!initialConfig ? (
          <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
            <Tabs 
              value={activeTab} 
              onChange={handleTabChange}
              aria-label={t('mcp.modal.tabsAria')}
              variant="scrollable"
              scrollButtons="auto"
              allowScrollButtonsMobile
              sx={{ px: { xs: 1, sm: 2 } }}
            >
              <Tab label={t('mcp.modal.spotlight')} value="spotlight" />
              <Tab data-tour="mcp-marketplace-tab" label={t('mcp.modal.marketplace')} value="marketplace" />
              <Tab label={t('mcp.modal.github')} value="github" />
              <Tab label={t('mcp.modal.local')} value="configure" />
              <Tab label={t('mcp.modal.remote')} value="remote" />
              <Tab label={t('mcp.modal.reference')} value="reference" />
            </Tabs>
          </Box>
        ) : null}

        <Box sx={{ p: { xs: 2, sm: 3 } }}>
          {/* Render the active tab or the edit form */}
          {initialConfig ? (
            <ConfigureTab
              initialConfig={initialConfig}
              onAdd={onAdd}
              onUpdate={onUpdate}
              onClose={onClose}
              onRestartAfterUpdate={onRestartAfterUpdate}
              onSaveAndAuthenticate={onSaveAndAuthenticate}
            />
          ) : activeTab === 'spotlight' ? (
            <SpotlightTab onAdd={onAdd} onClose={onClose} onHandoff={handleHandoff} />
          ) : activeTab === 'marketplace' ? (
            <MarketplaceTab onAdd={onAdd} onClose={onClose} onHandoff={handleHandoff} />
          ) : activeTab === 'github' ? (
            <GitHubTab
              onAdd={onAdd}
              onClose={onClose}
              onHandoff={handleHandoff}
              initialGitHubUrl={githubPrefillUrl}
            />
          ) : activeTab === 'configure' ? (
            <ConfigureTab
              initialConfig={parsedConfig}
              onAdd={onAdd}
              onClose={onClose}
              autoTestRun={autoTestRun}
              handoffId={handoffId}
              onSaveAndAuthenticate={onSaveAndAuthenticate}
            />
          ) : activeTab === 'remote' ? (
            <RemoteTab onAdd={onAdd} onClose={onClose} onHandoff={handleHandoff} />
          ) : (
            <ReferenceServersTab onAdd={onAdd} onClose={onClose} onHandoff={handleHandoff} />
          )}
        </Box>
      </DialogContent>
    </Dialog>
  );
};

export default ServerModal;
