'use client';

import React from 'react';
import EnvEditor from './EnvEditor';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp/MCPEnvManager');

interface EnvManagerProps {
  serverName: string | null;
}

const EnvManager: React.FC<EnvManagerProps> = ({ serverName }) => {
  const { servers, saveEnv } = useServerStatus();

  // Find the selected server
  const selectedServer = serverName 
    ? servers.find(server => server.name === serverName) 
    : null;

  // Handle saving environment variables
  const handleSaveEnv = async (env: Record<string, string>) => {
    if (!serverName) return;
    
    log.debug(`Saving environment variables for server: ${serverName}`);
    await saveEnv(serverName, env);
  };

  // If no server is selected, show a message
  if (!serverName || !selectedServer) {
    return (
      <div className="mt-8 border rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">Environment Variables</h3>
        <p className="text-gray-500">Please select a server to manage environment variables.</p>
      </div>
    );
  }

  return (
    <div className="mt-8">
      <EnvEditor
        serverName={serverName}
        initialEnv={selectedServer.env || {}}
        onSave={handleSaveEnv}
      />
    </div>
  );
};

export default EnvManager;
