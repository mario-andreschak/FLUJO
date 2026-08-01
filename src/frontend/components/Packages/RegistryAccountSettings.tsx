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
import type { RegistryAccountStatus, RegistryOAuthProvider } from '@/shared/types/registry';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';
import Trans from '@/frontend/components/shared/Trans';

const log = createLogger('frontend/components/Packages/RegistryAccountSettings');

type Feedback = { type: 'success' | 'error' | 'info'; text: string } | null;

/**
 * Package-registry account settings (issue #197): sign up / log in, the
 * "confirm your email" state with a resend button, log out, and the registry
 * base-URL override. Tokens are never shown — only a confirmation badge and the
 * publisher handle.
 */
export default function RegistryAccountSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<RegistryAccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Feedback>(null);

  const [tab, setTab] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [handle, setHandle] = useState('');

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

  // Surface the OAuth callback outcome (#207). The callback route redirects back
  // to `/packages?registry_oauth=success|error`; show a banner, refresh masked
  // status, then strip the param so a reload doesn't re-show it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('registry_oauth');
    if (!outcome) return;
    setMessage(
      outcome === 'success'
        ? { type: 'success', text: t('packages.account.signedIn') }
        : { type: 'error', text: t('packages.account.oauthFailed') },
    );
    void refresh();
    params.delete('registry_oauth');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, [refresh, t]);

  const handleAuth = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = tab === 'signup'
        ? await registryService.signup(email.trim(), password, handle.trim())
        : await registryService.login(email.trim(), password);
      if (result.status === 'authenticated') {
        setMessage({ type: 'success', text: t('packages.account.signedIn') });
        setPassword('');
      } else if (result.status === 'confirmation_required') {
        setMessage({ type: 'info', text: result.message || t('packages.account.checkInbox') });
        setPassword('');
      } else {
        setMessage({ type: 'error', text: result.message || t('packages.account.authFailed') });
      }
      if (result.account) setStatus(result.account);
      else await refresh();
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('packages.account.authFailed') });
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
      setMessage({ type: 'success', text: t('packages.account.loggedOut') });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('packages.account.logoutFailed') });
    } finally {
      setBusy(false);
    }
  };

  const handleOAuth = async (provider: RegistryOAuthProvider) => {
    setBusy(true);
    setMessage(null);
    try {
      const { authorizationUrl } = await registryService.beginOAuth(provider);
      // Hand off to the registry's authorize page; we return here via the callback.
      window.location.assign(authorizationUrl);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('packages.account.oauthStartFailed') });
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
          ? { type: 'success', text: t('packages.account.confirmationSent') }
          : { type: 'error', text: result.message || t('packages.account.resendFailed') },
      );
    } finally {
      setBusy(false);
    }
  };

  const handleForgotPassword = async () => {
    const address = email.trim();
    if (!address) {
      setMessage({ type: 'info', text: t('packages.account.enterEmail') });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      // Enumeration-safe: show the same message whether or not the account exists.
      await registryService.requestPasswordReset(address);
      setMessage({
        type: 'info',
        text: t('packages.account.resetSent'),
      });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('packages.account.resetFailed') });
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
          ? { type: 'success', text: t('packages.account.urlSaved') }
          : { type: 'error', text: result.message || t('packages.account.invalidUrl') },
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
        {t('packages.account.intro')}
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
              <Chip size="small" color="success" label={t('packages.account.confirmed')} />
            ) : (
              <Chip size="small" color="warning" label={t('packages.account.unconfirmed')} />
            )}
          </Stack>
          <Box>
            <Button variant="outlined" onClick={handleLogout} disabled={busy}>
              {t('packages.account.logout')}
            </Button>
          </Box>
        </Stack>
      ) : pendingConfirmation ? (
        <Stack spacing={2}>
          <Alert severity="info">
            <Trans
              message="packages.account.confirmationHelp"
              values={{ email: <strong>{status?.email}</strong> }}
            />
          </Alert>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={handleResend} disabled={busy}>
              {t('packages.account.resend')}
            </Button>
            <Button onClick={handleLogout} disabled={busy}>
              {t('packages.account.different')}
            </Button>
          </Stack>
        </Stack>
      ) : (
        <Stack spacing={2}>
          <Tabs value={tab} onChange={(_e, v) => setTab(v)}>
            <Tab value="login" label={t('packages.account.login')} />
            <Tab value="signup" label={t('packages.account.signup')} />
          </Tabs>
          <TextField
            label={t('packages.account.email')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            fullWidth
            autoComplete="username"
          />
          <TextField
            label={t('packages.account.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            fullWidth
            autoComplete={tab === 'signup' ? 'new-password' : 'current-password'}
          />
          {tab === 'signup' && (
            <TextField
              label={t('packages.account.handle')}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              fullWidth
              autoComplete="username"
              helperText={t('packages.account.handleHelp')}
            />
          )}
          <Box>
            <Button
              variant="contained"
              onClick={handleAuth}
              disabled={busy || !email.trim() || !password || (tab === 'signup' && !handle.trim())}
            >
              {tab === 'signup' ? t('packages.account.signup') : t('packages.account.login')}
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
                {t('packages.account.forgot')}
              </Button>
            </Box>
          )}
          <Divider>{t('packages.account.or')}</Divider>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button variant="outlined" onClick={() => handleOAuth('github')} disabled={busy}>
              {t('packages.account.github')}
            </Button>
          </Stack>
        </Stack>
      )}

      <Divider sx={{ my: 3 }} />

      <Typography variant="subtitle2" gutterBottom>
        {t('packages.account.registryUrl')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('packages.account.defaultUrl', { url: defaultUrl })}
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
          {t('packages.account.save')}
        </Button>
      </Stack>
    </Box>
  );
}
