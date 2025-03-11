'use client';

import React from 'react';
import {
  Alert,
  Box,
  Button,
  Stack,
  TextField,
  Typography
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
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
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
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
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
