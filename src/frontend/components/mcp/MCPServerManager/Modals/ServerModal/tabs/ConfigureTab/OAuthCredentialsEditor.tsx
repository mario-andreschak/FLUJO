'use client';

import React, { useState } from 'react';
import { Box, Button, IconButton, Link, TextField, Tooltip, Typography } from '@mui/material';
import LinkIcon from '@mui/icons-material/Link';
import CancelIcon from '@mui/icons-material/Cancel';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { MASKED_API_KEY } from '@/shared/types/constants';
import { useI18n } from '@/frontend/contexts/I18nContext';
import Trans from '@/frontend/components/shared/Trans';

interface OAuthCredentialsEditorProps {
  clientId: string;
  // Current stored value for the secret, as delivered by the backend: MASKED_API_KEY when a
  // secret is saved (the real value is never sent to the browser), a "${global:VAR}" string
  // when bound to a global variable, or '' when unset. Sent back verbatim on save unless the
  // user edits it (MASKED_API_KEY tells the backend to keep the stored secret).
  clientSecret: string;
  onClientIdChange: (clientId: string) => void;
  onClientSecretChange: (clientSecret: string) => void;
}

const GLOBAL_BINDING_RE = /^\$\{global:([^}]+)\}$/;

/**
 * Optional OAuth client credentials for streamable/SSE MCP servers.
 *
 * Most MCP servers self-register via Dynamic Client Registration (DCR) — leave these blank and
 * just click "Authenticate". A minority (e.g. Asana's V2 server) disable DCR and require a
 * pre-registered app; enter that app's Client ID / Secret here. These are the standard OAuth
 * 2.0 client-credential fields, so the same two inputs cover every such server.
 *
 * The secret mirrors how model API keys work: it is masked (never shown), can be bound to a
 * global variable, and is encrypted at rest by the backend.
 */
const OAuthCredentialsEditor: React.FC<OAuthCredentialsEditorProps> = ({
  clientId,
  clientSecret,
  onClientIdChange,
  onClientSecretChange,
}) => {
  const { globalEnvVars } = useStorage();
  const { t } = useI18n();
  const [showBindModal, setShowBindModal] = useState(false);

  const bindingMatch = clientSecret.match(GLOBAL_BINDING_RE);
  const isBound = !!bindingMatch;
  const boundVar = bindingMatch?.[1] ?? null;

  // The exact redirect URI the provider sends; must be allow-listed in the OAuth app.
  const callbackUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/oauth/callback` : '/api/oauth/callback';

  const handleSelectGlobalVar = (key: string) => {
    onClientSecretChange(`\${global:${key}}`);
    setShowBindModal(false);
  };

  return (
    <Box sx={{ position: 'relative' }}>
      <Typography variant="subtitle2" gutterBottom>
        {t('mcp.local.oauth.title')}{' '}
        <Typography component="span" variant="caption" color="text.secondary">{t('mcp.local.optional')}</Typography>
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        <Trans
          message="mcp.local.oauth.help"
          values={{
            specLink: (
              <Link href="https://modelcontextprotocol.io/specification/draft/basic/authorization" target="_blank" rel="noopener">
                {t('mcp.local.oauth.spec')}
              </Link>
            ),
          }}
        />
      </Typography>

      <TextField
        fullWidth
        size="small"
        label={t('mcp.local.oauth.clientId')}
        value={clientId}
        onChange={e => onClientIdChange(e.target.value)}
        placeholder="e.g. 1234567890abcdef"
        variant="outlined"
        sx={{ mb: 1.5 }}
      />

      <TextField
        fullWidth
        size="small"
        label={t('mcp.local.oauth.clientSecret')}
        type={isBound ? 'text' : 'password'}
        value={clientSecret}
        onChange={e => onClientSecretChange(e.target.value)}
        placeholder={t('mcp.local.oauth.secretPlaceholder')}
        variant="outlined"
        autoComplete="off"
        InputProps={{
          readOnly: isBound,
          endAdornment: isBound ? (
            <Tooltip title={t('mcp.local.oauth.unbind')}>
              <IconButton size="small" onClick={() => onClientSecretChange('')}>
                <CancelIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip title={t('mcp.local.headers.bind')}>
              <IconButton size="small" onClick={() => setShowBindModal(true)}>
                <LinkIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ),
        }}
        helperText={
          isBound
            ? t('mcp.local.oauth.bound', { variable: boundVar ?? '' })
            : clientSecret === MASKED_API_KEY
              ? t('mcp.local.oauth.storedSecret')
              : undefined
        }
      />

      {/* The callback URL the user must register in the provider's OAuth app. */}
      <Box sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          {t('mcp.local.oauth.redirect')}
        </Typography>
        <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>{callbackUrl}</Typography>
        <Tooltip title={t('mcp.local.oauth.copyRedirect')}>
          <IconButton size="small" onClick={() => navigator.clipboard.writeText(callbackUrl)}>
            <ContentCopyIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {showBindModal && (
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 400,
            bgcolor: 'background.paper',
            boxShadow: 24,
            p: 3,
            borderRadius: 1,
            zIndex: 9999,
          }}
        >
          <Typography variant="h6" component="h2" sx={{ mb: 2 }}>
            {t('mcp.local.oauth.bindTitle')}
          </Typography>
          {Object.keys(globalEnvVars).length === 0 ? (
            <Typography sx={{ mb: 2 }}>
              {t('mcp.local.headers.noGlobals')}
            </Typography>
          ) : (
            <Box sx={{ maxHeight: 300, overflow: 'auto', mb: 2 }}>
              {Object.keys(globalEnvVars).map(key => (
                <Button
                  key={key}
                  onClick={() => handleSelectGlobalVar(key)}
                  fullWidth
                  sx={{ justifyContent: 'flex-start', textAlign: 'left', mb: 1, p: 1, '&:hover': { bgcolor: 'action.hover' } }}
                >
                  {/* Values are secrets — never display them here, just the key. */}
                  <Typography>{key}</Typography>
                </Button>
              ))}
            </Box>
          )}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={() => setShowBindModal(false)}>{t('mcp.local.cancel')}</Button>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default OAuthCredentialsEditor;
