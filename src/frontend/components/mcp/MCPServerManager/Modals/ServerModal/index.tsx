'use client';

import React, { useState, useEffect } from 'react';
import { ServerModalProps } from './types';
import { MCPServerConfig } from '@/utils/mcp/';
import GitHubTab from './tabs/GitHubTab';
import LocalServerTab from './tabs/LocalServerTab';
import MarketplaceTab from './tabs/MarketplaceTab';
import SpotlightTab from './tabs/SpotlightTab';
import ReferenceServersTab from './tabs/ReferenceServersTab';
import RemoteTab from './tabs/RemoteTab';
import { useThemeUtils } from '@/frontend/utils/theme';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  IconButton,
  Tabs,
  Tab,
  Box,
  Typography
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

const ServerModal: React.FC<ServerModalProps> = ({
  isOpen,
  onClose,
  onAdd,
  initialConfig,
  onUpdate,
  onRestartAfterUpdate,
  onSaveAndAuthenticate
}) => {
  const [activeTab, setActiveTab] = useState<'spotlight' | 'marketplace' | 'github' | 'local' | 'reference' | 'remote'>('spotlight');
  
  // Store parsed configuration from GitHub tab
  const [parsedConfig, setParsedConfig] = useState<MCPServerConfig | null>(null);
  // Marketplace handoff: the config is ready to run, so the local tab should
  // start a test run automatically. Cleared on any manual tab change.
  const [autoTestRun, setAutoTestRun] = useState<boolean>(false);
  // Marketplace "manual setup" handoff: repository URL to prefill in the GitHub tab
  const [githubPrefillUrl, setGithubPrefillUrl] = useState<string>('');
  
  // Track which tabs have been visited/initialized
  const [initializedTabs, setInitializedTabs] = useState<{
    spotlight: boolean;
    marketplace: boolean;
    github: boolean;
    local: boolean;
    reference: boolean;
    remote: boolean;
  }>({
    spotlight: false,
    marketplace: false,
    github: false,
    local: false,
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

  const { getThemeValue } = useThemeUtils();
  
  const handleTabChange = (event: React.SyntheticEvent, newValue: 'spotlight' | 'marketplace' | 'github' | 'local' | 'reference' | 'remote') => {
    // A manual tab change is not a marketplace handoff — don't re-trigger the auto run
    // or keep a stale GitHub-URL prefill around
    setAutoTestRun(false);
    setGithubPrefillUrl('');
    setActiveTab(newValue);
  };

  // Handle close with state reset
  const handleClose = () => {
    // Reset parsed config when modal is closed
    setParsedConfig(null);
    setAutoTestRun(false);
    setGithubPrefillUrl('');
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
      PaperProps={{
        sx: {
          width: '95vw',
          maxWidth: '95vw',
          maxHeight: '95vh',
          height: 'auto',
        }
      }}
    >
      <DialogTitle 
        component="div"
        sx={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
          pb: 1
        }}
      >
        <Typography variant="h6">
          {initialConfig ? `Edit MCP Server: ${initialConfig.name}` : 'Add MCP Server'}
        </Typography>
        <IconButton
          edge="end"
          color="inherit"
          onClick={handleClose}
          aria-label="close"
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ p: 0 }}>
        {/* Only show tabs in creation mode, not in edit mode */}
        {!initialConfig ? (
          <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
            <Tabs 
              value={activeTab} 
              onChange={handleTabChange}
              aria-label="server configuration tabs"
              sx={{ px: 2 }}
            >
              <Tab label="Spotlight" value="spotlight" />
              <Tab label="Marketplace" value="marketplace" />
              <Tab label="GitHub" value="github" />
              <Tab label="Local Server" value="local" />
              <Tab label="Remote" value="remote" />
              <Tab label="Reference Servers" value="reference" />
            </Tabs>
          </Box>
        ) : null}

        <Box sx={{ p: 3 }}>
          {/* Render the active tab or the edit form */}
          {initialConfig ? (
            <LocalServerTab
              initialConfig={initialConfig}
              onAdd={onAdd}
              onUpdate={onUpdate}
              onClose={onClose}
              onRestartAfterUpdate={onRestartAfterUpdate}
              onSaveAndAuthenticate={onSaveAndAuthenticate}
            />
          ) : activeTab === 'spotlight' ? (
            <SpotlightTab
              onAdd={onAdd}
              onClose={onClose}
              setActiveTab={setActiveTab}
              onUpdate={(config, options) => {
                setParsedConfig(config);
                setAutoTestRun(Boolean(options?.autoTestRun));
              }}
            />
          ) : activeTab === 'marketplace' ? (
            <MarketplaceTab
              onAdd={onAdd}
              onClose={onClose}
              setActiveTab={setActiveTab}
              onUpdate={(config, options) => {
                setParsedConfig(config);
                setAutoTestRun(Boolean(options?.autoTestRun));
              }}
              onOpenInGitHubTab={(repoUrl) => {
                setGithubPrefillUrl(repoUrl);
                setActiveTab('github');
              }}
            />
          ) : activeTab === 'github' ? (
            <GitHubTab
              onAdd={onAdd}
              onClose={onClose}
              setActiveTab={setActiveTab}
              initialGitHubUrl={githubPrefillUrl}
              onUpdate={(config) => {
                setParsedConfig(config);
                setAutoTestRun(false);
              }}
            />
          ) : activeTab === 'local' ? (
            <LocalServerTab
              initialConfig={parsedConfig}
              onAdd={onAdd}
              onClose={onClose}
              autoTestRun={autoTestRun}
              onSaveAndAuthenticate={onSaveAndAuthenticate}
            />
          ) : activeTab === 'remote' ? (
            <RemoteTab
              onAdd={onAdd}
              onClose={onClose}
              setActiveTab={setActiveTab}
              onUpdate={(config) => {
                setParsedConfig(config);
                setAutoTestRun(false);
              }}
            />
          ) : (
            <ReferenceServersTab
              onAdd={onAdd}
              onClose={onClose}
              setActiveTab={setActiveTab}
              onUpdate={(config) => {
                setParsedConfig(config);
                setAutoTestRun(false);
              }}
            />
          )}
        </Box>
      </DialogContent>
    </Dialog>
  );
};

export default ServerModal;
