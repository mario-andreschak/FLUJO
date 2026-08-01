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
import { useI18n } from '@/frontend/contexts/I18nContext';

export default function EncryptionSettings() {
  const { setKey, changeKey, verifyKey, isEncryptionInitialized, isUserEncryptionEnabled } = useStorage();
  const { t } = useI18n();
  
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

  // After setting or changing the custom password the encryption state changes
  // app-wide (lock screen, status chip, session flags). Reload the page once so
  // every consumer re-evaluates from a clean load instead of leaving stale UI.
  const scheduleReload = () => {
    if (typeof window !== 'undefined') {
      setTimeout(() => window.location.reload(), 800);
    }
  };

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
          text: t('settings.encryption.minLength'),
        });
        setIsLoading(false);
        return;
      }
      
      // Validate password confirmation
      if (newKey !== confirmKey) {
        setMessage({
          type: 'error',
          text: t('settings.encryption.mismatch'),
        });
        setIsLoading(false);
        return;
      }
      
      // Initialize encryption with the new password
      await setKey(newKey);
      
      setMessage({
        type: 'success',
        text: t('settings.encryption.setSuccess'),
      });
      setNewKey('');
      setConfirmKey('');
      setIsInitialized(true);
      scheduleReload();
    } catch (error) {
      setMessage({
        type: 'error',
        text: t('settings.encryption.setFailed'),
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
          text: t('settings.encryption.newMinLength'),
        });
        setIsLoading(false);
        return;
      }
      
      // Verify current password
      const isValid = await verifyKey(currentKey);
      if (!isValid) {
        setMessage({
          type: 'error',
          text: t('settings.encryption.currentIncorrect'),
        });
        setIsLoading(false);
        return;
      }
      
      // Change the password
      const success = await changeKey(currentKey, changeNewKey);
      
      if (success) {
        setMessage({
          type: 'success',
          text: t('settings.encryption.changeSuccess'),
        });
        setCurrentKey('');
        setChangeNewKey('');
        scheduleReload();
      } else {
        setMessage({
          type: 'error',
          text: t('settings.encryption.changeFailed'),
        });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: t('settings.encryption.changeError'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ width: '100%' }}>
      <Typography variant="h6" gutterBottom>
        {t('settings.encryption.title')}
      </Typography>
      
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {t('settings.encryption.description')}
      </Typography>

      {message && (
        <Alert severity={message.type} sx={{ mb: 3 }}>
          {message.text}
        </Alert>
      )}

      {/* Status indicator */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
        <Typography variant="body1" sx={{ mr: 2 }}>{t('settings.encryption.status')}</Typography>
        {isInitialized ? (
          isUserEncryption ? (
            <Chip 
              icon={<LockOutlined />} 
              label={t('settings.encryption.statusCustom')}
              color="success" 
              variant="outlined" 
            />
          ) : (
            <Chip 
              icon={<LockOpenOutlined />} 
              label={t('settings.encryption.statusDefault')}
              color="primary" 
              variant="outlined" 
            />
          )
        ) : (
          <Chip 
            label={t('settings.encryption.statusNone')}
            color="error" 
            variant="outlined" 
          />
        )}
      </Box>

      {!isInitialized || !isUserEncryption ? (
        <Paper elevation={2} sx={{ p: 3, mb: 4 }}>
          <Typography variant="subtitle1" gutterBottom fontWeight="bold">
            {t('settings.encryption.setTitle')}
          </Typography>
          
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t(isInitialized ? 'settings.encryption.defaultHelp' : 'settings.encryption.newHelp')}
          </Typography>
          
          <Box component="form" onSubmit={handleInitialize}>
            <TextField
              fullWidth
              label={t('settings.encryption.newPassword')}
              variant="outlined"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              type={showNewKey ? 'text' : 'password'}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label={showNewKey ? t('encryption.unlock.hidePassword') : t('encryption.unlock.showPassword')}
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
              label={t('settings.encryption.confirmPassword')}
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
              {t(isInitialized ? 'settings.encryption.upgrade' : 'settings.encryption.setAction')}
            </Button>
          </Box>
        </Paper>
      ) : isUserEncryption ? (
        <Paper elevation={2} sx={{ p: 3 }}>
          <Typography variant="subtitle1" gutterBottom fontWeight="bold">
            {t('settings.encryption.changeTitle')}
          </Typography>
          
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('settings.encryption.changeHelp')}
          </Typography>
          
          <Box component="form" onSubmit={handleChangePassword}>
            <TextField
              fullWidth
              label={t('settings.encryption.currentPassword')}
              variant="outlined"
              value={currentKey}
              onChange={(e) => setCurrentKey(e.target.value)}
              type={showCurrentKey ? 'text' : 'password'}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label={showCurrentKey ? t('encryption.unlock.hidePassword') : t('encryption.unlock.showPassword')}
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
              label={t('settings.encryption.newPassword')}
              variant="outlined"
              value={changeNewKey}
              onChange={(e) => setChangeNewKey(e.target.value)}
              type={showChangeNewKey ? 'text' : 'password'}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label={showChangeNewKey ? t('encryption.unlock.hidePassword') : t('encryption.unlock.showPassword')}
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
              {t('settings.encryption.changeAction')}
            </Button>
          </Box>
        </Paper>
      ) : null}
      
      {/* Security information */}
      <Box sx={{ mt: 4 }}>
        <Alert severity={isUserEncryption ? "warning" : "info"}>
          <Typography variant="subtitle2" fontWeight="bold">
            {t(isUserEncryption ? 'settings.encryption.securityTitle' : 'settings.encryption.defaultTitle')}
          </Typography>
          {isUserEncryption ? (
            <Typography variant="body2">
              • {t('settings.encryption.security1')}<br />
              • {t('settings.encryption.security2')}<br />
              • {t('settings.encryption.security3')}
            </Typography>
          ) : (
            <Typography variant="body2">
              • {t('settings.encryption.default1')}<br />
              • {t('settings.encryption.default2')}<br />
              • {t('settings.encryption.default3')}
            </Typography>
          )}
        </Alert>
      </Box>
    </Box>
  );
}
