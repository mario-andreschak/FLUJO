'use client';

import React from 'react';
import { useThemeUtils } from '@/frontend/utils/theme';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import { formatEnvVariables } from '../../utils/configUtils';
import { mcpService } from '@/frontend/services/mcp';
import { createLogger } from '@/utils/logger';
import {
  Box,
  Button,
  Stack,
  TextField,
  Typography
} from '@mui/material';

const log = createLogger('frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/LocalServerTab/EnvManager');

interface EnvManagerProps {
  env: Record<string, string>;
  onEnvChange: (env: Record<string, string>) => void;
  onParseEnvExample?: () => Promise<void>;
  onParseEnvClipboard?: () => Promise<void>;
  isParsingEnv?: boolean;
  serverName?: string;
}

const EnvManager: React.FC<EnvManagerProps> = ({
  env,
  onEnvChange,
  onParseEnvExample,
  onParseEnvClipboard,
  isParsingEnv = false,
  serverName
}) => {
  const handleEnvTextChange = async (text: string) => {
    try {
      const envObj = text.split('\n')
        .filter(line => line.trim() !== '')
        .reduce((acc, line) => {
          const [key, val] = line.split('=').map(s => s.trim());
          if (key && val) {
            acc[key] = val;
          }
          return acc;
        }, {} as Record<string, string>);
      
      // Call the original onEnvChange
      onEnvChange(envObj);
    } catch (error) {
      console.error('Failed to parse env variables:', error);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle2">
          Environment Variables (KEY=value, one per line)
        </Typography>
        {(onParseEnvExample || onParseEnvClipboard) && (
          <Stack direction="row" spacing={1}>
            {onParseEnvExample && (
              <Button
                size="small"
                startIcon={<ContentPasteIcon />}
                onClick={onParseEnvExample}
                disabled={isParsingEnv}
                color="inherit"
                sx={{ color: 'text.secondary' }}
              >
                Parse .env.example
              </Button>
            )}
            {onParseEnvClipboard && (
              <Button
                size="small"
                startIcon={<ContentPasteIcon />}
                onClick={onParseEnvClipboard}
                disabled={isParsingEnv}
                color="inherit"
                sx={{ color: 'text.secondary' }}
              >
                Parse Env from Clipboard
              </Button>
            )}
          </Stack>
        )}
      </Box>
      <TextField
        fullWidth
        multiline
        rows={3}
        value={formatEnvVariables(env)}
        onChange={e => handleEnvTextChange(e.target.value)}
        placeholder="API_KEY=your-key"
        variant="outlined"
        size="small"
      />
    </Box>
  );
};

export default EnvManager;
