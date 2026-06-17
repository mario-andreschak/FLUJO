"use client";

import { Box, Button, Container, Grid, Paper, Typography, Alert, CircularProgress } from '@mui/material';
import Link from 'next/link';
import Image from 'next/image';
import { useState, useEffect, useRef } from 'react';
import { createLogger } from '@/utils/logger';
import { useStorage } from '@/frontend/contexts/StorageContext';

const log = createLogger('app/page');

const features = [
  {
    title: 'Model Management',
    description: 'Securely store and manage your AI model configurations and API keys.',
    icon: '/file.svg',
    link: '/models',
  },
  {
    title: 'MCP Integration',
    description: 'Connect and manage MCP servers with environment variables and tool testing.',
    icon: '/globe.svg',
    link: '/mcp',
  },
  {
    title: 'Flow Builder',
    description: 'Create and manage visual flows for your AI applications.',
    icon: '/window.svg',
    link: '/flows',
  },
];

export default function HomePage() {
  log.debug('Rendering HomePage');
  const { settings } = useStorage();
  const [encryptionKeySet, setEncryptionKeySet] = useState(true); // Assume key is set initially
  const [isUserEncryption, setIsUserEncryption] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ behindBy: number; branch: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const updateChecked = useRef(false);

  // Check for available updates once, if the user has enabled the setting.
  useEffect(() => {
    if (!settings?.update?.checkOnStartup || updateChecked.current) {
      return;
    }
    updateChecked.current = true;
    const checkForUpdate = async () => {
      try {
        log.info('Checking for FLUJO updates');
        const res = await fetch('/api/update');
        if (!res.ok) return;
        const data = await res.json();
        if (data.updateAvailable) {
          setUpdateInfo({ behindBy: data.behindBy, branch: data.branch });
        }
      } catch (error) {
        log.warn('Update check failed', error);
      }
    };
    checkForUpdate();
  }, [settings?.update?.checkOnStartup]);

  const handleUpdateNow = async () => {
    setUpdating(true);
    setUpdateError(null);
    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        setUpdateError(data.error || 'Update failed.');
        setUpdating(false);
        return;
      }
      if (data.restarting) {
        // The server stops, rebuilds, and comes back up (can take minutes).
        // Poll a lightweight endpoint until it goes DOWN and then UP again,
        // then reload into the new build.
        let sawDown = false;
        const poll = async () => {
          try {
            const ping = await fetch('/api/cwd', { cache: 'no-store' });
            if (ping.ok && sawDown) {
              window.location.reload();
              return;
            }
          } catch {
            sawDown = true; // server is down -> rebuilding
          }
          setTimeout(poll, 3000);
        };
        setTimeout(poll, 5000);
      } else {
        setUpdating(false);
        setUpdateInfo(null);
      }
    } catch (error) {
      log.error('Update failed', error);
      setUpdateError('Update failed.');
      setUpdating(false);
    }
  };

  useEffect(() => {
    log.info('Checking encryption status');
    const checkEncryptionStatus = async () => {
      try {
        // Check if encryption is initialized
        log.debug('Fetching encryption initialization status');
        const initResponse = await fetch('/api/encryption/secure', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'check_initialized'
          }),
        });
        
        if (initResponse.ok) {
          const initData = await initResponse.json();
          log.debug('Encryption initialization status received', { initialized: initData.initialized });
          setEncryptionKeySet(initData.initialized === true);
          
          // If encryption is initialized, check if it's user encryption
          if (initData.initialized === true) {
            log.debug('Checking if user encryption is enabled');
            const userResponse = await fetch('/api/encryption/secure', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                action: 'check_user_encryption'
              }),
            });
            
            if (userResponse.ok) {
              const userData = await userResponse.json();
              log.debug('User encryption status received', { userEncryption: userData.userEncryption });
              setIsUserEncryption(userData.userEncryption === true);
            }
          }
        } else {
          log.error('Failed to check encryption status');
          setEncryptionKeySet(false);
        }
      } catch (error) {
        log.error('Error checking encryption status', error);
        setEncryptionKeySet(false);
      }
    };

    checkEncryptionStatus();
  }, []);

  return (
    <Container maxWidth="lg" sx={{ py: 8 }}>
      {updateInfo && (
        <Alert
          severity="info"
          sx={{ mb: 4 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={handleUpdateNow}
              disabled={updating}
              startIcon={updating ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              {updating ? 'Updating…' : 'Update now'}
            </Button>
          }
        >
          {updating
            ? 'Updating FLUJO and restarting — the page will reload automatically.'
            : `A FLUJO update is available (${updateInfo.behindBy} new commit${updateInfo.behindBy === 1 ? '' : 's'} on ${updateInfo.branch}).`}
        </Alert>
      )}
      {updateError && (
        <Alert severity="error" sx={{ mb: 4 }} onClose={() => setUpdateError(null)}>
          {updateError}
        </Alert>
      )}
      {!encryptionKeySet ? (
        <Alert severity="warning" sx={{ mb: 4 }}>
          Warning: Encryption is not initialized. Sensitive data may not be properly protected. Please visit the <Link href="/settings">settings</Link> page.
        </Alert>
      ) : !isUserEncryption ? (
        <Alert severity="info" sx={{ mb: 4 }}>
          Your data is protected with default encryption. For enhanced security, set a custom encryption password in the <Link href="/settings">settings</Link>.
        </Alert>
      ) : null}
      <Box sx={{ textAlign: 'center', mb: 8 }}>
        <Typography variant="h2" component="h1" gutterBottom>
          FLUJO
        </Typography>
        <Typography variant="h5" color="text.secondary" sx={{ mb: 4 }}>
          A browser-based application for managing models, MCP servers, flows and chat interactions
        </Typography>
        <Button component={Link} href="/models" variant="contained" size="large" sx={{ mr: 2 }}>
          Get Started
        </Button>
      </Box>

      <Grid container spacing={4}>
        {features.map((feature) => (
          <Grid item xs={12} md={4} key={feature.title}>
            <Paper
              component={Link}
              href={feature.link}
              sx={{
                p: 4,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                textDecoration: 'none',
                color: 'text.primary',
                transition: 'transform 0.2s',
                '&:hover': {
                  transform: 'translateY(-4px)',
                },
              }}
            >
              <Box sx={{ mb: 2, width: 48, height: 48, position: 'relative' }}>
                <Image src={feature.icon} alt={feature.title} fill style={{ objectFit: 'contain' }} />
              </Box>
              <Typography variant="h5" component="h2" gutterBottom>
                {feature.title}
              </Typography>
              <Typography color="text.secondary">{feature.description}</Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>
    </Container>
  );
}
