'use client';

import React, { useEffect } from 'react';
import ToolTester, { type ToolTesterPrefill } from './ToolTester';
import Spinner from '@/frontend/components/shared/Spinner';
import { useServerTools } from '@/frontend/hooks/useServerTools';
import { mcpService } from '@/frontend/services/mcp';
import { createLogger } from '@/utils/logger';
import { useThemeUtils } from '@/frontend/utils/theme';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/mcp/MCPToolManager');

interface ToolManagerProps {
  serverName: string | null;
  onClose?: () => void; // Optional handler to dismiss the tool tester panel
  prefill?: ToolTesterPrefill;
}

const ToolManager: React.FC<ToolManagerProps> = ({ serverName, onClose, prefill }) => {
  const { t, formatNumber } = useI18n();
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

  // Handle tool testing
  const handleTestTool = async (toolName: string, params: Record<string, any>, timeout?: number) => {
    log.debug(`Testing tool ${toolName} with params:`, params);
    if (timeout !== undefined) {
      log.debug(`Using timeout: ${timeout} seconds`);
    }
    return await testTool(toolName, params, timeout);
  };

  // Set up a periodic refresh for tools
  useEffect(() => {
    if (serverName) {
      // Set up a periodic refresh every 30 seconds
      const intervalId = setInterval(() => {
        log.debug('Periodic tool refresh');
        // Clear cache first to ensure we get fresh data
        mcpService.clearToolsCache(serverName);
        loadTools(true); // Force reload
      }, 30000);
      
      // Clean up on unmount
      return () => clearInterval(intervalId);
    }
  }, [loadTools, serverName]);

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
          {t('mcp.tools.managerServer', { server: serverName || t('mcp.tools.noServer') })}
        </h3>
        <div className="text-red-500">
          <p>{t('mcp.tools.errorLoading', { error })}</p>
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
                {t('mcp.tools.retrying')}
              </>
            ) : (
              t('mcp.tools.retry')
            )}
          </button>
          {retryCount > 0 && (
            <p className="text-sm mt-1">{t('mcp.tools.retryAttempt', { count: formatNumber(retryCount) })}</p>
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
          {t('mcp.tools.manager')}
        </h3>
        <p style={{ color: getThemeValue('#6b7280', '#9ca3af') }}>
          {t('mcp.tools.selectServer')}
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
        onClose={onClose}
        prefill={prefill}
      />
      {isLoading && (
        <div className="mt-4 flex items-center space-x-2 text-blue-500">
          <Spinner size="small" color="primary" />
          <p>{t('mcp.tools.loading')}</p>
        </div>
      )}
      {error && tools && tools.length > 0 && (
        <div className="mt-2 text-yellow-500">
          <p>{t('mcp.tools.warning', { error })}</p>
          <p className="text-sm">{t('mcp.tools.cached')}</p>
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
                <span className="text-xs">{t('mcp.tools.retrying')}</span>
              </>
            ) : (
              t('mcp.tools.retry')
            )}
          </button>
          {retryCount > 0 && (
            <p className="text-xs mt-1">{t('mcp.tools.retryAttempt', { count: formatNumber(retryCount) })}</p>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolManager;
