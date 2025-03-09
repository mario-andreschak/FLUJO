"use client";

import React, { useState, useEffect } from 'react';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/EncryptionAuthDialog');
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Alert,
  Box,
  Typography,
  InputAdornment,
  IconButton,
  CircularProgress,
} from '@mui/material';
import { Visibility, VisibilityOff, LockOutlined } from '@mui/icons-material';
import { useStorage } from '@/frontend/contexts/StorageContext';

export default function EncryptionAuthDialog() {
  const { verifyKey, isEncryptionInitialized, isUserEncryptionEnabled } = useStorage();
  
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);

  // Check if user encryption is enabled on component mount
  useEffect(() => {
    const checkEncryptionStatus = async () => {
      log.debug('Checking encryption status');
      try {
        setIsCheckingStatus(true);
        
        // Check if encryption is initialized
        const initialized = await isEncryptionInitialized();
        log.debug(`Encryption initialized: ${initialized}`);
        if (!initialized) {
          // No encryption, no need for auth
          log.info('No encryption initialized, skipping authentication');
          setIsAuthenticated(true);
          setIsOpen(false);
          setIsCheckingStatus(false);
          return;
        }
        
        // Check if user encryption is enabled
        const userEncryption = await isUserEncryptionEnabled();
        log.debug(`User encryption enabled: ${userEncryption}`);
        if (!userEncryption) {
          // Default encryption, no need for auth
          log.info('Default encryption in use, skipping authentication');
          setIsAuthenticated(true);
          setIsOpen(false);
          setIsCheckingStatus(false);
          return;
        }
        
        // Check if already authenticated in this session
        const sessionAuth = sessionStorage.getItem('encryption_authenticated');
        log.debug(`Session authentication status: ${sessionAuth}`);
        if (sessionAuth === 'true') {
          log.info('Already authenticated in this session');
          setIsAuthenticated(true);
          setIsOpen(false);
          setIsCheckingStatus(false);
          return;
        }
        
        // User encryption is enabled and not authenticated, show dialog
        log.info('User encryption enabled and not authenticated, showing dialog');
        setIsOpen(true);
        setIsCheckingStatus(false);
      } catch (error) {
        log.error('Failed to check encryption status:', error);
        setIsCheckingStatus(false);
        // Default to authenticated to avoid blocking the app
        setIsAuthenticated(true);
      }
    };
    
    checkEncryptionStatus();
  }, [isEncryptionInitialized, isUserEncryptionEnabled]);

  const handleVerify = async () => {
    if (!password.trim()) {
      log.warn('Empty password submitted');
      setError('Password is required');
      return;
    }
    
    log.debug('Verifying encryption password');
    setIsLoading(true);
    setError(null);
    
    try {
      const isValid = await verifyKey(password);
      log.debug(`Password verification result: ${isValid}`);
      
      if (isValid) {
        // The verifyKey function now stores the token in session storage
        // We just need to set the authenticated flag in our component
        log.info('Authentication successful');
        setIsAuthenticated(true);
        setIsOpen(false);
      } else {
        log.warn('Invalid password provided');
        setError('Invalid password');
      }
    } catch (error) {
      log.error('Failed to verify password:', error);
      setError('An error occurred while verifying the password');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleVerify();
    }
  };

  // If still checking status or already authenticated, don't show anything
  if (isCheckingStatus || isAuthenticated) {
    return null;
  }

  return (
    <Dialog 
      open={isOpen} 
      maxWidth="sm" 
      fullWidth
      disableEscapeKeyDown
      onClose={() => {}} // Empty onClose to prevent closing by backdrop click
    >
      <DialogTitle>
        <Box display="flex" alignItems="center">
          <LockOutlined sx={{ mr: 1 }} />
          <Typography variant="h6">Encryption Password Required</Typography>
        </Box>
      </DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        
        <Typography variant="body1" paragraph>
          This application is configured with custom encryption. Please enter your encryption password to access your encrypted data.
        </Typography>
        
        <TextField
          autoFocus
          fullWidth
          label="Encryption Password"
          variant="outlined"
          type={showPassword ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={handleKeyDown}
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  aria-label="toggle password visibility"
                  onClick={() => setShowPassword(!showPassword)}
                  edge="end"
                >
                  {showPassword ? <VisibilityOff /> : <Visibility />}
                </IconButton>
              </InputAdornment>
            ),
          }}
          sx={{ mt: 2 }}
        />
      </DialogContent>
      <DialogActions>
        <Button
          variant="contained"
          color="primary"
          onClick={handleVerify}
          disabled={isLoading}
          startIcon={isLoading ? <CircularProgress size={20} /> : null}
        >
          {isLoading ? 'Verifying...' : 'Unlock'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
