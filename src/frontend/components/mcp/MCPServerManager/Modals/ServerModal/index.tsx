'use client';

import React, { useState, useEffect } from 'react';
import { ServerModalProps } from './types';
import { MCPServerConfig } from '@/utils/mcp/';
import GitHubTab from './tabs/GitHubTab';
import LocalServerTab from './tabs/LocalServerTab';
import SmitheryTab from './tabs/SmitheryTab';

const ServerModal: React.FC<ServerModalProps> = ({
  isOpen,
  onClose,
  onAdd,
  initialConfig,
  onUpdate,
  onRestartAfterUpdate
}) => {
  const [activeTab, setActiveTab] = useState<'github' | 'local' | 'smithery'>('github');
  
  // Store parsed configuration from GitHub tab
  const [parsedConfig, setParsedConfig] = useState<MCPServerConfig | null>(null);
  
  // Track which tabs have been visited/initialized
  const [initializedTabs, setInitializedTabs] = useState<{
    github: boolean;
    local: boolean;
    smithery: boolean;
  }>({
    github: false,
    local: false,
    smithery: false
  });

  // Initialize fields only on first visit to each tab in add mode
  useEffect(() => {
    if (!initialConfig && !initializedTabs[activeTab]) {
      // Mark this tab as visited
      setInitializedTabs(prev => ({ ...prev, [activeTab]: true }));
    }
  }, [activeTab, initialConfig, initializedTabs]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-screen-xl max-h-[80vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">{initialConfig ? `Edit MCP Server: ${initialConfig.name}` : 'Add MCP Server'}</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            ✕
          </button>
        </div>

        {/* Only show tabs in creation mode, not in edit mode */}
        {!initialConfig ? (
          <div className="flex border-b mb-4">
            <button
              className={`px-4 py-2 ${
                activeTab === 'github'
                  ? 'border-b-2 border-blue-500'
                  : 'text-gray-500'
              }`}
              onClick={() => setActiveTab('github')}
            >
              GitHub
            </button>
            <button
              className={`px-4 py-2 ${
                activeTab === 'local'
                  ? 'border-b-2 border-blue-500'
                  : 'text-gray-500'
              }`}
              onClick={() => setActiveTab('local')}
            >
              Local Server
            </button>
            <button
              className={`px-4 py-2 ${
                activeTab === 'smithery'
                  ? 'border-b-2 border-blue-500'
                  : 'text-gray-500'
              }`}
              onClick={() => setActiveTab('smithery')}
            >
              Install from Registry
            </button>
          </div>
        ) : (
          <div className="mb-4">
            {/* No tabs in edit mode */}
          </div>
        )}

        {/* Render the active tab or the edit form */}
        {initialConfig ? (
          <LocalServerTab
            initialConfig={initialConfig}
            onAdd={onAdd}
            onUpdate={onUpdate}
            onClose={onClose}
            onRestartAfterUpdate={onRestartAfterUpdate}
          />
        ) : activeTab === 'github' ? (
          <GitHubTab
            onAdd={onAdd}
            onClose={onClose}
            setActiveTab={setActiveTab}
            onUpdate={(config) => setParsedConfig(config)}
          />
        ) : activeTab === 'local' ? (
          <LocalServerTab
            initialConfig={parsedConfig}
            onAdd={onAdd}
            onClose={onClose}
          />
        ) : (
          <SmitheryTab
            onAdd={onAdd}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
};

export default ServerModal;
