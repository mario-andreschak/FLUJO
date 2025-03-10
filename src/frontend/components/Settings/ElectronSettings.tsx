"use client";

import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Switch,
  FormControlLabel,
  Alert,
  Paper,
  Divider,
  Button,
  Tooltip,
  CircularProgress
} from '@mui/material';
import InfoIcon from '@mui/icons-material/Info';
import { createLogger } from '@/utils/logger';
import { isElectron, setElectronNetworkMode, getElectronAPI } from '@/utils/shared';

const log = createLogger('frontend/components/Settings/ElectronSettings');

export default function ElectronSettings() {
  const [networkMode, setNetworkMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<{ path?: string; version?: string }>({});
  
  // Check if running in Electron
  const runningInElectron = isElectron();
  
  // Get current network mode setting
  useEffect(() => {
    if (runningInElectron) {
      const api = getElectronAPI();
      
      // Get app info
      const fetchAppInfo = async () => {
        try {
          const path = await api?.getAppPath();
          const version = await api?.getAppVersion();
          setAppInfo({ path, version });
        } catch (err) {
          log.error('Error fetching app info:', err);
        }
      };
      
      fetchAppInfo();
      
      // Try to read config file to get current network mode
      // This is just a placeholder - in a real implementation, you'd have a proper API
      // to get the current setting from Electron
      setNetworkMode(false);
    }
  }, [runningInElectron]);
  
  // Handle network mode toggle
  const handleNetworkModeChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = event.target.checked;
    setNetworkMode(newValue);
    
    if (runningInElectron) {
      setLoading(true);
      setError(null);
      setSuccess(null);
      
      try {
        const result = await setElectronNetworkMode(newValue);
        
        if (result.success) {
          setSuccess(`Network mode ${newValue ? 'enabled' : 'disabled'}. Restart the application for changes to take effect.`);
        } else {
          setError(result.error || 'Failed to update network mode');
          // Revert the switch if there was an error
          setNetworkMode(!newValue);
        }
      } catch (err) {
        log.error('Error setting network mode:', err);
        setError('An unexpected error occurred');
        // Revert the switch if there was an error
        setNetworkMode(!newValue);
      } finally {
        setLoading(false);
      }
    }
  };
  
  if (!runningInElectron) {
    return (
      <Alert severity="info">
        These settings are only available when running in Electron desktop mode.
      </Alert>
    );
  }
  
  return (
    <Box>
      <Typography variant="body1" gutterBottom>
        Configure Electron-specific settings for the desktop application.
      </Typography>
      
      <Paper sx={{ p: 2, mt: 2 }}>
        <Typography variant="subtitle1" fontWeight="bold">
          Network Access
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Control whether the application is accessible from other devices on your network.
        </Typography>
        
        <FormControlLabel
          control={
            <Switch
              checked={networkMode}
              onChange={handleNetworkModeChange}
              disabled={loading}
            />
          }
          label={
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Typography>Enable network access</Typography>
              <Tooltip title="When enabled, the application will be accessible from other devices on your network. This is useful for accessing the application from mobile devices or other computers. A restart is required for changes to take effect.">
                <InfoIcon fontSize="small" sx={{ ml: 1, color: 'text.secondary' }} />
              </Tooltip>
            </Box>
          }
        />
        
        {loading && (
          <Box sx={{ display: 'flex', alignItems: 'center', mt: 1 }}>
            <CircularProgress size={20} sx={{ mr: 1 }} />
            <Typography variant="body2">Updating settings...</Typography>
          </Box>
        )}
        
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
        
        {success && (
          <Alert severity="success" sx={{ mt: 2 }}>
            {success}
          </Alert>
        )}
      </Paper>
      
      <Divider sx={{ my: 3 }} />
      
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight="bold">
          Application Information
        </Typography>
        
        <Box sx={{ mt: 2 }}>
          <Typography variant="body2">
            <strong>Version:</strong> {appInfo.version || 'Unknown'}
          </Typography>
          <Typography variant="body2" sx={{ mt: 1, wordBreak: 'break-all' }}>
            <strong>Application Path:</strong> {appInfo.path || 'Unknown'}
          </Typography>
        </Box>
      </Paper>
    </Box>
  );
}
