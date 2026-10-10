"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
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
import {
  installEncryptionLockInterceptor,
  ENCRYPTION_LOCKED_EVENT,
  ENCRYPTION_UNLOCKED_EVENT,
} from '@/frontend/utils/encryptionLock';
import { useI18n } from '@/frontend/contexts/I18nContext';
import CredentialMigrationRecovery from './CredentialMigrationRecovery';
import { getSelectedWorkspace, withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type { TranslationKey } from '@/frontend/i18n';

export default function EncryptionAuthDialog() {
  const { verifyKey } = useStorage();
  const { t } = useI18n();
  
  const [workspace] = useState(getSelectedWorkspace);
  const statusGeneration = useRef(0);
  const mounted = useRef(true);
  const verifyBusy = useRef(false);
  const [migrationPending, setMigrationPending] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isSetup, setIsSetup] = useState(false);
  const [operatorUnavailable, setOperatorUnavailable] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);

  // Check if user encryption is enabled on component mount
  const checkEncryptionStatus = useCallback(async () => {
      const generation = ++statusGeneration.current;
      const current = () => mounted.current && generation === statusGeneration.current;
      log.debug('Checking encryption status');
      try {
        setIsCheckingStatus(true);
        
        const response = await fetch(withWorkspaceUrl('/api/encryption/secure', workspace), { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status' }) });
        if (!response.ok) throw new Error('Encryption status unavailable');
        const status = await response.json();
        if (!current()) return;
        if (status.protection === 'migration-pending' && status.initialized === true && status.locked === true) {
          setMigrationPending(true); setIsSetup(false); setOperatorUnavailable(false);
          setPassword(''); setConfirmation(''); setError(null);
          setIsAuthenticated(false); setIsOpen(true); setIsCheckingStatus(false); return;
        }
        if (typeof status.initialized !== 'boolean' || typeof status.locked !== 'boolean'
            || !['uninitialized', 'legacy-default', 'passphrase', 'operator-file'].includes(status.protection)) {
          throw new Error('Encryption status unavailable');
        }
        setMigrationPending(false); setError(null);
        const initialized = status.initialized;
        setIsSetup(!initialized && status.protection !== 'operator-file');
        setOperatorUnavailable(false);
        log.debug(`Encryption initialized: ${initialized}`);
        if (!initialized && status.protection !== 'operator-file') {
          setIsSetup(true);
          setIsAuthenticated(false);
          setIsOpen(true);
          setIsCheckingStatus(false);
          return;
        }
        
        // Check if user encryption is enabled
        const userEncryption = status.protection === 'passphrase';
        log.debug(`User encryption enabled: ${userEncryption}`);
        if (!userEncryption) {
          setOperatorUnavailable(status.protection === 'operator-file' && status.locked);
          setIsAuthenticated(!status.locked);
          setIsOpen(status.locked);
          setIsCheckingStatus(false);
          return;
        }
        
        // Check if already authenticated in this session
        if (!status.locked) {
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
        if (!current()) return;
        log.error('Failed to check encryption status');
        setIsCheckingStatus(false);
        setError('encryption.unlock.error');
        setIsAuthenticated(false);
        setIsOpen(true);
      }
    }, [workspace]);
  useEffect(() => {
    mounted.current = true;
    void checkEncryptionStatus();
    return () => { mounted.current = false; ++statusGeneration.current; };
  }, [checkEncryptionStatus]);

  // Global lockdown handling (issue #77): install the 423 interceptor once and
  // re-open the lock screen whenever any request reports the server is locked
  // (e.g. the process was restarted and lost its in-memory unlock state).
  useEffect(() => {
    installEncryptionLockInterceptor();
    const onLocked = () => {
      log.info('Encryption locked signal received; showing lock screen');
      setIsAuthenticated(false);
      setIsCheckingStatus(false);
      setIsOpen(true);
      void checkEncryptionStatus();
    };
    window.addEventListener(ENCRYPTION_LOCKED_EVENT, onLocked);
    return () => window.removeEventListener(ENCRYPTION_LOCKED_EVENT, onLocked);
  }, [checkEncryptionStatus]);

  const handleVerify = async () => {
    if (verifyBusy.current || migrationPending || operatorUnavailable) return;
    if (!password.trim()) {
      log.warn('Empty password submitted');
      setError('encryption.unlock.required');
      return;
    }
    if (isSetup && password.length < 12) { setError('settings.encryption.minLength'); return; }
    if (isSetup && password !== confirmation) { setError('settings.encryption.mismatch'); return; }
    
    log.debug('Verifying encryption password');
    verifyBusy.current = true;
    const generation = statusGeneration.current;
    setIsLoading(true);
    setError(null);
    
    try {
      if (isSetup) {
        const response = await fetch(withWorkspaceUrl('/api/encryption/secure', workspace), { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'initialize', password }) });
        if (!response.ok || (await response.json()).success !== true) throw new Error('Private encryption setup failed');
        setIsSetup(false);
      }
      const isValid = await verifyKey(password);
      if (!mounted.current || generation !== statusGeneration.current) return;
      log.debug(`Password verification result: ${isValid}`);
      
      if (isValid) {
        // The verifyKey function now stores the token in session storage
        // We just need to set the authenticated flag in our component
        log.info('Authentication successful');
        setIsAuthenticated(true);
        setIsOpen(false);
        // Signal consumers that fell back to defaults while locked (e.g. the
        // StorageContext settings hydration behind the 423 gate) to re-read
        // their data now that gated routes will succeed.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(ENCRYPTION_UNLOCKED_EVENT));
        }
      } else {
        log.warn('Invalid password provided');
        setError('encryption.unlock.invalid');
      }
    } catch (error) {
      log.error('Failed to verify password');
      setError('encryption.unlock.error');
    } finally {
      setPassword('');
      setConfirmation('');
      verifyBusy.current = false;
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleVerify();
    }
  };

  // If still checking status or already authenticated, don't show anything
  if ((isCheckingStatus && !migrationPending) || isAuthenticated) {
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
      <DialogTitle component="div">
        <Box display="flex" alignItems="center">
          <LockOutlined sx={{ mr: 1 }} />
          <Typography variant="h6">{t(isSetup ? 'settings.encryption.setTitle' : 'encryption.unlock.title')}</Typography>
        </Box>
      </DialogTitle>
      {migrationPending ? <DialogContent><CredentialMigrationRecovery workspace={workspace} onSettled={checkEncryptionStatus} /></DialogContent> : <>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {t(error)}
          </Alert>
        )}
        
        {operatorUnavailable && <Alert severity="error">{t('encryption.operator.unavailable')}</Alert>}
        <Typography variant="body1" paragraph>
          {t(isSetup ? 'settings.encryption.newHelp' : 'encryption.unlock.description')}
        </Typography>
        
        <TextField
          autoFocus
          disabled={operatorUnavailable}
          fullWidth
          label={t(isSetup ? 'settings.encryption.newPassword' : 'encryption.unlock.password')}
          variant="outlined"
          type={showPassword ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={handleKeyDown}
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  aria-label={showPassword ? t('encryption.unlock.hidePassword') : t('encryption.unlock.showPassword')}
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
        {isSetup && <TextField fullWidth type="password" label={t('settings.encryption.confirmPassword')}
          value={confirmation} onChange={event => setConfirmation(event.target.value)} onKeyDown={handleKeyDown} sx={{ mt: 2 }} />}
      </DialogContent>
      <DialogActions>
        <Button
          variant="contained"
          color="primary"
          onClick={handleVerify}
          disabled={isLoading || operatorUnavailable}
          startIcon={isLoading ? <CircularProgress size={20} /> : null}
        >
          {isLoading ? t('encryption.unlock.verifying') : t(isSetup ? 'settings.encryption.setAction' : 'encryption.unlock.action')}
        </Button>
      </DialogActions>
      </>}
    </Dialog>
  );
}
