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
  // Array of messages to show during installation and building
  const progressMessages = [
    "Still working on it...",
    "Don't close this window!",
    "This can take some time...",
    "Backend is processing your request...",
    "Almost there, please wait...",
    "Processing in progress..."
  ];
  
  const installMessages = [
    ...progressMessages,
    "Installing dependencies...",
    "NPM install in progress...",
    "Fetching packages from registry..."
  ];
  
  const buildMessages = [
    ...progressMessages,
    "Building server...",
    "Compiling source code...",
    "Bundling files..."
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
          Install Script
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
            {isInstalling ? 'Installing...' : '1) Install Dependencies'}
          </Button>
        </Box>
      </Box>
      
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Build Command
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
            {isBuilding ? 'Building...' : '2) Build Server'}
          </Button>
        </Box>
      </Box>
    </Stack>
  );
};

export default BuildTools;
