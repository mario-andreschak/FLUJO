'use client';

import React, { useEffect } from 'react';
import ToolTester from './ToolTester';
import Spinner from '@/frontend/components/shared/Spinner';
import { useServerTools } from '@/frontend/hooks/useServerTools';
import { useServerEvents } from '@/frontend/hooks/useServerEvents';
import { mcpService } from '@/frontend/services/mcp';
import { createLogger } from '@/utils/logger';
import { useThemeUtils } from '@/frontend/utils/theme';

const log = createLogger('frontend/components/mcp/MCPToolManager');

interface ToolManagerProps {
  serverName: string | null;
}

const ToolManager: React.FC<ToolManagerProps> = ({ serverName }) => {
  const {
    tools,
    isLoading,
    error,
    loadTools,
    retryLoadTools,
    isRetrying,
    retryCount,
    testTool
  } = useServerTools(serverName);

  const { lastEvent, isSubscribed } = useServerEvents(serverName);

  // Handle tool testing
  const handleTestTool = async (toolName: string, params: Record<string, any>, timeout?: number) => {
    log.debug(`Testing tool ${toolName} with params:`, params);
    if (timeout !== undefined) {
      log.debug(`Using timeout: ${timeout} seconds`);
    }
    return await testTool(toolName, params, timeout);
  };

  // Reload tools when we receive a toolsUpdate event
  useEffect(() => {
    if (lastEvent && lastEvent.type === 'toolsUpdate') {
      log.debug('Received toolsUpdate event, reloading tools');
      // Clear cache first to ensure we get fresh data
      if (serverName) {
        mcpService.clearToolsCache(serverName);
      }
      loadTools(true); // Force reload
    }
  }, [lastEvent, loadTools, serverName]);

  const { getThemeValue } = useThemeUtils();
  
  // If there's an error and no tools, show a message
  if (error && (!tools || tools.length === 0)) {
    return (
      <div className="mt-8 border rounded-lg p-4" style={{
        backgroundColor: getThemeValue('#fef2f2', '#3a2222'),
        borderColor: getThemeValue('#fecaca', '#5a3333'),
        color: getThemeValue('#333', '#f0f0f0')
      }}>
        <h3 className="text-lg font-semibold mb-4" style={{ color: getThemeValue('#111', '#f8f8f8') }}>
          Tool Manager - {serverName || 'No Server Selected'}
        </h3>
        <div className="text-red-500">
          <p>Error loading tools: {error}</p>
          <button
            onClick={() => {
              // Clear cache first to ensure we get fresh data
              if (serverName) {
                mcpService.clearToolsCache(serverName);
              }
              retryLoadTools();
            }}
            className="mt-2 px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center"
            disabled={isRetrying}
          >
            {isRetrying ? (
              <>
                <Spinner size="small" color="white" className="mr-2" />
                Retrying...
              </>
            ) : (
              'Retry'
            )}
          </button>
          {retryCount > 0 && (
            <p className="text-sm mt-1">Retry attempt: {retryCount}</p>
          )}
        </div>
      </div>
    );
  }

  // If no server is selected, show a message
  if (!serverName) {
    return (
      <div className="mt-8 border rounded-lg p-4" style={{
        backgroundColor: getThemeValue('white', '#2a2a2a'),
        borderColor: getThemeValue('#e5e7eb', '#3a3a3a'),
        color: getThemeValue('#333', '#f0f0f0')
      }}>
        <h3 className="text-lg font-semibold mb-4" style={{ color: getThemeValue('#111', '#f8f8f8') }}>
          Tool Manager
        </h3>
        <p style={{ color: getThemeValue('#6b7280', '#9ca3af') }}>
          Please select a server to view and test tools.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-8" style={{ color: getThemeValue('#333', '#f0f0f0') }}>
      <ToolTester
        serverName={serverName}
        tools={tools}
        onTestTool={handleTestTool}
      />
      {isLoading && (
        <div className="mt-4 flex items-center space-x-2 text-blue-500">
          <Spinner size="small" color="primary" />
          <p>Loading tools...</p>
        </div>
      )}
      {error && tools && tools.length > 0 && (
        <div className="mt-2 text-yellow-500">
          <p>Warning: {error}</p>
          <p className="text-sm">Using cached tools. Some tools may be unavailable.</p>
          <button
            onClick={() => {
              // Clear cache first to ensure we get fresh data
              if (serverName) {
                mcpService.clearToolsCache(serverName);
              }
              retryLoadTools();
            }}
            className="mt-1 px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center"
            disabled={isRetrying}
          >
            {isRetrying ? (
              <>
                <Spinner size="small" color="white" className="mr-1" />
                <span className="text-xs">Retrying...</span>
              </>
            ) : (
              'Retry'
            )}
          </button>
          {retryCount > 0 && (
            <p className="text-xs mt-1">Retry attempt: {retryCount}</p>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolManager;
