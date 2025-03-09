'use client';

import React from 'react';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import { formatEnvVariables } from '../../utils/configUtils';
import { mcpService } from '@/frontend/services/mcp';
import { createLogger } from '@/utils/logger';

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
    <div>
      <div className="flex justify-between items-center mb-1">
        <label className="block text-sm font-medium">
          Environment Variables (KEY=value, one per line)
        </label>
        {(onParseEnvExample || onParseEnvClipboard) && (
          <div className="flex gap-2">
            {onParseEnvExample && (
              <button
                type="button"
                onClick={onParseEnvExample}
                disabled={isParsingEnv}
                className="flex items-center px-2 py-1 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <ContentPasteIcon sx={{ width: 16, height: 16, marginRight: 0.5 }} />
                Parse .env.example
              </button>
            )}
            {onParseEnvClipboard && (
              <button
                type="button"
                onClick={onParseEnvClipboard}
                disabled={isParsingEnv}
                className="flex items-center px-2 py-1 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <ContentPasteIcon sx={{ width: 16, height: 16, marginRight: 0.5 }} />
                Parse Env from Clipboard
              </button>
            )}
          </div>
        )}
      </div>
      <textarea
        value={formatEnvVariables(env)}
        onChange={e => handleEnvTextChange(e.target.value)}
        className="w-full px-3 py-2 border rounded-lg"
        placeholder="API_KEY=your-key"
        rows={3}
      />
    </div>
  );
};

export default EnvManager;
