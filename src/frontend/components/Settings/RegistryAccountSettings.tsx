"use client";

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { registryService } from '@/frontend/services/registry';
import type { RegistryAccountStatus } from '@/shared/types/registry';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Settings/RegistryAccountSettings');

type Feedback = { type: 'success' | 'error' | 'info'; text: string } | null;

/**
 * Package-registry account settings (issue #197): sign up / log in, the
 * "confirm your email" state with a resend button, log out, and the registry
 * base-URL override. Tokens are never shown — only a confirmation badge and the
 * publisher handle. Follows the GlobalEnvSettings section conventions.
 */
export default function RegistryAccountSettings() {
  const [status, setStatus] = useState<RegistryAccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Feedback>(null);

  const [tab, setTab] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [baseUrl, setBaseUrl] = useState('');
  const [defaultUrl, setDefaultUrl] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [s, settings] = await Promise.all([
        registryService.getStatus(),
        registryService.getSettings(),
      ]);
      setStatus(s);
      setDefaultUrl(settings.defaultUrl);
      setBaseUrl(settings.usingDefault ? '' : settings.baseUrl);
    } catch (err) {
      log.warn('Failed to load registry account status', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAuth = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = tab === 'signup'
        ? await registryService.signup(email.trim(), password)
        : await registryService.login(email.trim(), password);
      if (result.status === 'authenticated') {
        setMessage({ type: 'success', text: 'Signed in to the package registry.' });
        setPassword('');
      } else if (result.status === 'confirmation_required') {
        setMessage({ type: 'info', text: result.message || 'Check your inbox to confirm your email.' });
        setPassword('');
      } else {
        setMessage({ type: 'error', text: result.message || 'Authentication failed.' });
      }
      if (result.account) setStatus(result.account);
      else await refresh();
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Authentication failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await registryService.logout();
      await refresh();
      setMessage({ type: 'success', text: 'Logged out.' });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to log out.' });
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await registryService.resendConfirmation();
      setMessage(
        result.success
          ? { type: 'success', text: 'Confirmation email sent.' }
          : { type: 'error', text: result.message || 'Failed to resend confirmation.' },
      );
    } finally {
      setBusy(false);
    }
  };

  const handleForgotPassword = async () => {
    const address = email.trim();
    if (!address) {
      setMessage({ type: 'info', text: 'Enter your account email above, then tap “Forgot password?”.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      // Enumeration-safe: show the same message whether or not the account exists.
      await registryService.requestPasswordReset(address);
      setMessage({
        type: 'info',
        text: 'If an account exists for that email, a password-reset link is on its way. Follow the link to set a new password.',
      });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to request a password reset.' });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSettings = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await registryService.saveSettings(baseUrl.trim());
      setMessage(
        result.success
          ? { type: 'success', text: 'Registry URL saved.' }
          : { type: 'error', text: result.message || 'Invalid registry URL.' },
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  const signedIn = Boolean(status?.signedIn);
  const pendingConfirmation = Boolean(status?.email && !signedIn && status && !status.isConfirmed);

  return (
    <Box sx={{ width: '100%' }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Sign in to the FLUJO package registry to publish packages. Browsing and installing
        packages does not require an account — only publishing does, and your email must be
        confirmed first. Your registry tokens are encrypted at rest and never shown here.
      </Typography>

      {message && (
        <Alert severity={message.type} sx={{ mb: 2 }} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}

      {signedIn ? (
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="subtitle1">{status?.email}</Typography>
            {status?.publisherHandle && <Chip size="small" label={`@${status.publisherHandle}`} />}
            {status?.isConfirmed ? (
              <Chip size="small" color="success" label="Confirmed" />
            ) : (
              <Chip size="small" color="warning" label="Unconfirmed" />
            )}
          </Stack>
          <Box>
            <Button variant="outlined" onClick={handleLogout} disabled={busy}>
              Log out
            </Button>
          </Box>
        </Stack>
      ) : pendingConfirmation ? (
        <Stack spacing={2}>
          <Alert severity="info">
            We sent a confirmation link to <strong>{status?.email}</strong>. Confirm your email,
            then log in to start publishing.
          </Alert>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={handleResend} disabled={busy}>
              Resend confirmation email
            </Button>
            <Button onClick={handleLogout} disabled={busy}>
              Use a different account
            </Button>
          </Stack>
        </Stack>
      ) : (
        <Stack spacing={2}>
          <Tabs value={tab} onChange={(_e, v) => setTab(v)}>
            <Tab value="login" label="Log in" />
            <Tab value="signup" label="Sign up" />
          </Tabs>
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            fullWidth
            autoComplete="username"
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            fullWidth
            autoComplete={tab === 'signup' ? 'new-password' : 'current-password'}
          />
          <Box>
            <Button
              variant="contained"
              onClick={handleAuth}
              disabled={busy || !email.trim() || !password}
            >
              {tab === 'signup' ? 'Sign up' : 'Log in'}
            </Button>
          </Box>
          {tab === 'login' && (
            <Box>
              <Button
                variant="text"
                size="small"
                onClick={handleForgotPassword}
                disabled={busy}
                sx={{ textTransform: 'none', px: 0 }}
              >
                Forgot password?
              </Button>
            </Box>
          )}
        </Stack>
      )}

      <Divider sx={{ my: 3 }} />

      <Typography variant="subtitle2" gutterBottom>
        Registry URL
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Leave blank to use the default ({defaultUrl}).
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          placeholder={defaultUrl}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          sx={{ minWidth: 320 }}
        />
        <Button variant="outlined" onClick={handleSaveSettings} disabled={busy}>
          Save
        </Button>
      </Stack>
    </Box>
  );
}
