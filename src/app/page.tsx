"use client";

import { Box, Button, Container, Grid, Paper, Typography, Alert } from '@mui/material';
import Link from 'next/link';
import Image from 'next/image';
import { useState, useEffect } from 'react';
import { createLogger } from '@/utils/logger';

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
  const [encryptionKeySet, setEncryptionKeySet] = useState(true); // Assume key is set initially
  const [isUserEncryption, setIsUserEncryption] = useState(false);

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
