"use client";

import React, { useState, useEffect } from 'react';
import {
  Box,
  TextField,
  Button,
  Typography,
  Alert,
  IconButton,
  InputAdornment,
  Divider,
  Paper,
  Chip,
} from '@mui/material';
import { Visibility, VisibilityOff, LockOutlined, LockOpenOutlined } from '@mui/icons-material';
import { useStorage } from '@/frontend/contexts/StorageContext';

export default function EncryptionSettings() {
  const { setKey, changeKey, verifyKey, isEncryptionInitialized, isUserEncryptionEnabled } = useStorage();
  
  // State for new key setup
  const [newKey, setNewKey] = useState('');
  const [confirmKey, setConfirmKey] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);
  
  // State for key change
  const [currentKey, setCurrentKey] = useState('');
  const [changeNewKey, setChangeNewKey] = useState('');
  const [showCurrentKey, setShowCurrentKey] = useState(false);
  const [showChangeNewKey, setShowChangeNewKey] = useState(false);
  
  // UI state
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isUserEncryption, setIsUserEncryption] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const checkEncryption = async () => {
      const initialized = await isEncryptionInitialized();
      const userEnabled = await isUserEncryptionEnabled();
      
      setIsInitialized(initialized);
      setIsUserEncryption(userEnabled);
    };

    checkEncryption();
  }, [isEncryptionInitialized, isUserEncryptionEnabled]);

  const handleInitialize = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setMessage(null);
    
    try {
      // Validate password
      if (newKey.length < 12) {
        setMessage({
          type: 'error',
          text: 'Encryption password must be at least 12 characters long for security',
        });
        setIsLoading(false);
        return;
      }
      
      // Validate password confirmation
      if (newKey !== confirmKey) {
        setMessage({
          type: 'error',
          text: 'Passwords do not match',
        });
        setIsLoading(false);
        return;
      }
      
      // Initialize encryption with the new password
      await setKey(newKey);
      
      setMessage({
        type: 'success',
        text: 'Encryption password set successfully',
      });
      setNewKey('');
      setConfirmKey('');
      setIsInitialized(true);
    } catch (error) {
      setMessage({
        type: 'error',
        text: 'Failed to set encryption password',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setMessage(null);
    
    try {
      // Validate new password
      if (changeNewKey.length < 12) {
        setMessage({
          type: 'error',
          text: 'New password must be at least 12 characters long for security',
        });
        setIsLoading(false);
        return;
      }
      
      // Verify current password
      const isValid = await verifyKey(currentKey);
      if (!isValid) {
        setMessage({
          type: 'error',
          text: 'Current password is incorrect',
        });
        setIsLoading(false);
        return;
      }
      
      // Change the password
      const success = await changeKey(currentKey, changeNewKey);
      
      if (success) {
        setMessage({
          type: 'success',
          text: 'Encryption password changed successfully',
        });
        setCurrentKey('');
        setChangeNewKey('');
      } else {
        setMessage({
          type: 'error',
          text: 'Failed to change encryption password',
        });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: 'An error occurred while changing the password',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ width: '100%' }}>
      <Typography variant="h6" gutterBottom>
        Encryption Settings
      </Typography>
      
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Set an encryption password to secure sensitive data like API keys and credentials. 
        This password is used to encrypt your data and is never stored directly.
      </Typography>

      {message && (
        <Alert severity={message.type} sx={{ mb: 3 }}>
          {message.text}
        </Alert>
      )}

      {/* Status indicator */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
        <Typography variant="body1" sx={{ mr: 2 }}>Current encryption status:</Typography>
        {isInitialized ? (
          isUserEncryption ? (
            <Chip 
              icon={<LockOutlined />} 
              label="Custom Password Protection" 
              color="success" 
              variant="outlined" 
            />
          ) : (
            <Chip 
              icon={<LockOpenOutlined />} 
              label="Default Encryption" 
              color="primary" 
              variant="outlined" 
            />
          )
        ) : (
          <Chip 
            label="No Encryption" 
            color="error" 
            variant="outlined" 
          />
        )}
      </Box>

      {!isInitialized || !isUserEncryption ? (
        <Paper elevation={2} sx={{ p: 3, mb: 4 }}>
          <Typography variant="subtitle1" gutterBottom fontWeight="bold">
            Set Custom Encryption Password
          </Typography>
          
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {isInitialized ? 
              "Your data is currently protected with default encryption. Set a custom password for enhanced security." :
              "Create a strong password to protect your sensitive data. Make sure to remember this password as it cannot be recovered if lost."}
          </Typography>
          
          <Box component="form" onSubmit={handleInitialize}>
            <TextField
              fullWidth
              label="New Password"
              variant="outlined"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              type={showNewKey ? 'text' : 'password'}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label="toggle password visibility"
                      onClick={() => setShowNewKey(!showNewKey)}
                      edge="end"
                    >
                      {showNewKey ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
              sx={{ mb: 2 }}
            />
            
            <TextField
              fullWidth
              label="Confirm Password"
              variant="outlined"
              value={confirmKey}
              onChange={(e) => setConfirmKey(e.target.value)}
              type={showNewKey ? 'text' : 'password'}
              sx={{ mb: 3 }}
            />
            
            <Button
              type="submit"
              variant="contained"
              color="primary"
              disabled={!newKey || !confirmKey || isLoading}
            >
              {isInitialized ? "Upgrade to Custom Password" : "Set Encryption Password"}
            </Button>
          </Box>
        </Paper>
      ) : isUserEncryption ? (
        <Paper elevation={2} sx={{ p: 3 }}>
          <Typography variant="subtitle1" gutterBottom fontWeight="bold">
            Change Encryption Password
          </Typography>
          
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            You can change your custom encryption password here. This will re-encrypt your data with the new password.
            Your data will remain intact.
          </Typography>
          
          <Box component="form" onSubmit={handleChangePassword}>
            <TextField
              fullWidth
              label="Current Password"
              variant="outlined"
              value={currentKey}
              onChange={(e) => setCurrentKey(e.target.value)}
              type={showCurrentKey ? 'text' : 'password'}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label="toggle current password visibility"
                      onClick={() => setShowCurrentKey(!showCurrentKey)}
                      edge="end"
                    >
                      {showCurrentKey ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
              sx={{ mb: 2 }}
            />
            
            <TextField
              fullWidth
              label="New Password"
              variant="outlined"
              value={changeNewKey}
              onChange={(e) => setChangeNewKey(e.target.value)}
              type={showChangeNewKey ? 'text' : 'password'}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label="toggle new password visibility"
                      onClick={() => setShowChangeNewKey(!showChangeNewKey)}
                      edge="end"
                    >
                      {showChangeNewKey ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
              sx={{ mb: 3 }}
            />
            
            <Button
              type="submit"
              variant="contained"
              color="primary"
              disabled={!currentKey || !changeNewKey || isLoading}
            >
              Change Password
            </Button>
          </Box>
        </Paper>
      ) : null}
      
      {/* Security information */}
      <Box sx={{ mt: 4 }}>
        <Alert severity={isUserEncryption ? "warning" : "info"}>
          <Typography variant="subtitle2" fontWeight="bold">
            {isUserEncryption ? "Important Security Information" : "About Default Encryption"}
          </Typography>
          {isUserEncryption ? (
            <Typography variant="body2">
              • Your custom encryption password is never stored directly on the server<br />
              • If you forget your password, you will not be able to access your encrypted data<br />
              • Consider using a password manager to securely store this password
            </Typography>
          ) : (
            <Typography variant="body2">
              • Your data is currently encrypted with a built-in default key<br />
              • This provides basic protection without requiring password setup<br />
              • For maximum security, set a custom password using the form above
            </Typography>
          )}
        </Alert>
      </Box>
    </Box>
  );
}
