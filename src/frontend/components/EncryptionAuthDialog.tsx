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
import {
  installEncryptionLockInterceptor,
  ENCRYPTION_LOCKED_EVENT,
  ENCRYPTION_UNLOCKED_EVENT,
} from '@/frontend/utils/encryptionLock';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n';

export default function EncryptionAuthDialog() {
  const { verifyKey, setKey, getEncryptionStatus } = useStorage();
  const { t } = useI18n();
  
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [operatorBlocked, setOperatorBlocked] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);

  // Server status is authoritative; a cached browser flag cannot unlock it.
  useEffect(() => {
    let active = true;
    const checkEncryptionStatus = async () => {
      try {
        const status = await getEncryptionStatus();
        if (!active) return;
        setNeedsSetup(!status.initialized && !status.recoveryRequired && status.protection === 'interactive');
        setRecoveryRequired(status.recoveryRequired);
        setOperatorBlocked(status.locked && status.protection === 'operator');
        setStatusUnavailable(false);
        setIsAuthenticated(!status.locked);
        setIsOpen(status.locked);
      } catch {
        if (!active) return;
        setStatusUnavailable(true);
        setIsAuthenticated(false);
        setIsOpen(true);
      } finally {
        if (active) setIsCheckingStatus(false);
      }
    };
    void checkEncryptionStatus();
    return () => { active = false; };
  }, [getEncryptionStatus]);

  // Global lockdown handling (issue #77): install the 423 interceptor once and
  // re-open the lock screen whenever any request reports the server is locked
  // (e.g. the process was restarted and lost its in-memory unlock state).
  useEffect(() => {
    installEncryptionLockInterceptor();
    const onLocked = () => {
      setIsAuthenticated(false);
      setIsCheckingStatus(false);
      setIsOpen(true);
      void getEncryptionStatus().then(status => {
        setNeedsSetup(!status.initialized && !status.recoveryRequired && status.protection === 'interactive');
        setRecoveryRequired(status.recoveryRequired);
        setOperatorBlocked(status.locked && status.protection === 'operator');
        setStatusUnavailable(false);
        setIsAuthenticated(!status.locked);
        setIsOpen(status.locked);
      }).catch(() => setStatusUnavailable(true));
    };
    window.addEventListener(ENCRYPTION_LOCKED_EVENT, onLocked);
    return () => window.removeEventListener(ENCRYPTION_LOCKED_EVENT, onLocked);
  }, [getEncryptionStatus]);

  const handleVerify = async () => {
    if (operatorBlocked || statusUnavailable || recoveryRequired) {
      setIsLoading(true);
      try {
        const status = await getEncryptionStatus();
        setNeedsSetup(!status.initialized && !status.recoveryRequired && status.protection === 'interactive');
        setRecoveryRequired(status.recoveryRequired);
        setOperatorBlocked(status.locked && status.protection === 'operator');
        setStatusUnavailable(false);
        setIsAuthenticated(!status.locked);
        setIsOpen(status.locked);
        if (!status.locked) window.dispatchEvent(new CustomEvent(ENCRYPTION_UNLOCKED_EVENT));
      } catch { setStatusUnavailable(true); }
      finally { setIsLoading(false); }
      return;
    }
    if (!password.trim()) {
      log.warn('Empty password submitted');
      setError('encryption.unlock.required');
      return;
    }
    
    log.debug('Verifying encryption password');
    setIsLoading(true);
    setError(null);
    
    try {
      if (needsSetup) {
        if (password.length < 12) { setError('settings.encryption.minLength'); return; }
        if (password !== confirmation) { setError('settings.encryption.mismatch'); return; }
        await setKey(password);
        // Initialization is acknowledged before authentication. A failed unlock
        // retries authentication, never overwrites the committed key metadata.
        setNeedsSetup(false);
      }
      const isValid = await verifyKey(password);
      log.debug(`Password verification result: ${isValid}`);
      
      if (isValid) {
        // The verifyKey function now stores the token in session storage
        // We just need to set the authenticated flag in our component
        log.info('Authentication successful');
        setIsAuthenticated(true);
        setIsOpen(false);
        setPassword('');
        setConfirmation('');
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
    } catch {
      log.error('Encryption setup or unlock failed');
      setError('encryption.unlock.error');
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
      <DialogTitle component="div">
        <Box display="flex" alignItems="center">
          <LockOutlined sx={{ mr: 1 }} />
          <Typography variant="h6">{t(needsSetup ? 'settings.encryption.title' : 'encryption.unlock.title')}</Typography>
        </Box>
      </DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {t(error)}
          </Alert>
        )}
        
        <Typography variant="body1" paragraph>
          {t(statusUnavailable ? 'encryption.status.unavailable' : recoveryRequired
            ? 'encryption.recovery.required' : operatorBlocked
            ? 'encryption.operator.unavailable' : needsSetup
              ? 'settings.encryption.newHelp' : 'encryption.unlock.description')}
        </Typography>
        
        {!operatorBlocked && !statusUnavailable && !recoveryRequired && <TextField
          autoFocus
          fullWidth
          label={t('encryption.unlock.password')}
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
        />}
        {needsSetup && !operatorBlocked && !statusUnavailable && !recoveryRequired && <TextField
          fullWidth label={t('settings.encryption.confirmPassword')} type="password"
          value={confirmation} onChange={event => setConfirmation(event.target.value)}
          onKeyDown={handleKeyDown} sx={{ mt: 2 }}
        />}
      </DialogContent>
      <DialogActions>
        <Button
          variant="contained"
          color="primary"
          onClick={handleVerify}
          disabled={isLoading}
          startIcon={isLoading ? <CircularProgress size={20} /> : null}
        >
          {t(isLoading ? 'encryption.unlock.verifying' : operatorBlocked || statusUnavailable || recoveryRequired
            ? 'encryption.status.retry' : needsSetup ? 'settings.encryption.setAction' : 'encryption.unlock.action')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
