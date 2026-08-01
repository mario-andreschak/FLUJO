'use client';

import React, { useState, useEffect } from 'react';
import {
  Alert,
  Box,
  Button,
  Stack,
  TextField,
  Typography,
  Paper,
  CircularProgress
} from '@mui/material';
import { MessageState } from '../../types';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface BuildToolsProps {
  installCommand: string;
  setinstallCommand: (script: string) => void;
  buildCommand: string;
  setBuildCommand: (command: string) => void;
  onInstall: () => Promise<void>;
  onBuild: () => Promise<void>;
  isInstalling: boolean;
  isBuilding: boolean;
  installCompleted: boolean;
  buildCompleted: boolean;
  buildMessage: MessageState | null;
}

const BuildTools: React.FC<BuildToolsProps> = ({
  installCommand,
  setinstallCommand,
  buildCommand,
  setBuildCommand,
  onInstall,
  onBuild,
  isInstalling,
  isBuilding,
  installCompleted,
  buildCompleted,
  buildMessage
}) => {
  const { t } = useI18n();
  // Array of messages to show during installation and building
  const progressMessages = [
    t('mcp.local.progress.stillWorking'),
    t('mcp.local.progress.keepOpen'),
    t('mcp.local.progress.mayTakeTime'),
    t('mcp.local.progress.backend'),
    t('mcp.local.progress.almostThere'),
    t('mcp.local.progress.processing')
  ];
  
  const installMessages = [
    ...progressMessages,
    t('mcp.local.progress.installingDependencies'),
    t('mcp.local.progress.npmInstall'),
    t('mcp.local.progress.fetchingPackages')
  ];
  
  const buildMessages = [
    ...progressMessages,
    t('mcp.local.progress.buildingServer'),
    t('mcp.local.progress.compiling'),
    t('mcp.local.progress.bundling')
  ];
  
  // State to track the current message indices
  const [installMessageIndex, setInstallMessageIndex] = useState(0);
  const [buildMessageIndex, setBuildMessageIndex] = useState(0);
  
  // Effect to rotate messages every 3 seconds when installing
  useEffect(() => {
    let intervalId: NodeJS.Timeout;
    
    if (isInstalling) {
      intervalId = setInterval(() => {
        setInstallMessageIndex(prevIndex => (prevIndex + 1) % installMessages.length);
      }, 3000);
    }
    
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [isInstalling, installMessages.length]);
  
  // Effect to rotate messages every 3 seconds when building
  useEffect(() => {
    let intervalId: NodeJS.Timeout;
    
    if (isBuilding) {
      intervalId = setInterval(() => {
        setBuildMessageIndex(prevIndex => (prevIndex + 1) % buildMessages.length);
      }, 3000);
    }
    
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [isBuilding, buildMessages.length]);
  return (
    <Stack spacing={3}>
      {/* Error message display */}
      {buildMessage && buildMessage.type === 'error' && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {buildMessage.text}
        </Alert>
      )}
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          {t('mcp.local.installScript')}
        </Typography>
        <TextField
          fullWidth
          size="small"
          value={installCommand}
          onChange={e => setinstallCommand(e.target.value)}
          variant="outlined"
        />
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', mt: 1 }}>
          {isInstalling && (
            <Paper 
              elevation={3} 
              sx={{ 
                p: 2, 
                mb: 2, 
                width: '100%', 
                bgcolor: 'info.lighter',
                display: 'flex',
                alignItems: 'center',
                gap: 2
              }}
            >
              <CircularProgress size={20} color="info" />
              <Typography variant="body2" color="info.dark" fontWeight="medium">
              {installMessages[installMessageIndex]}
              </Typography>
            </Paper>
          )}
          <Button
            variant="contained"
            color={installCompleted ? "success" : "primary"}
            onClick={onInstall}
            disabled={isInstalling}
          >
            {isInstalling ? t('mcp.local.installing') : t('mcp.local.installDependencies')}
          </Button>
        </Box>
      </Box>
      
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          {t('mcp.local.buildCommand')}
        </Typography>
        <TextField
          fullWidth
          size="small"
          value={buildCommand}
          onChange={e => setBuildCommand(e.target.value)}
          variant="outlined"
        />
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', mt: 1 }}>
          {isBuilding && (
            <Paper 
              elevation={3} 
              sx={{ 
                p: 2, 
                mb: 2, 
                width: '100%', 
                bgcolor: 'info.lighter',
                display: 'flex',
                alignItems: 'center',
                gap: 2
              }}
            >
              <CircularProgress size={20} color="info" />
              <Typography variant="body2" color="info.dark" fontWeight="medium">
                {buildMessages[buildMessageIndex]}
              </Typography>
            </Paper>
          )}
          <Button
            variant="contained"
            color={buildCompleted ? "success" : "primary"}
            onClick={onBuild}
            disabled={isBuilding}
          >
            {isBuilding ? t('mcp.local.building') : t('mcp.local.buildServer')}
          </Button>
        </Box>
      </Box>
    </Stack>
  );
};

export default BuildTools;
