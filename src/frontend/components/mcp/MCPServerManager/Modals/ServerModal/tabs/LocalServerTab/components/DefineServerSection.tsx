'use client';

import React from 'react';
import { MCPServerConfig } from '@/shared/types/mcp/mcp';
import LocalServerForm from '../LocalServerForm';
import SectionHeader from './SectionHeader';

interface DefineServerSectionProps {
  localConfig: MCPServerConfig;
  setLocalConfig: (config: MCPServerConfig) => void;
  isExpanded: boolean;
  toggleSection: () => void;
  onRootPathSelect: () => void;
}

const DefineServerSection: React.FC<DefineServerSectionProps> = ({
  localConfig,
  setLocalConfig,
  isExpanded,
  toggleSection,
  onRootPathSelect
}) => {
  // Determine section status based on form completion
  const getSectionStatus = () => {
    if (!localConfig.name || !localConfig.rootPath) {
      return 'error';
    }
    return 'default';
  };

  return (
    <div className={`bg-gray-50 dark:bg-gray-800 border ${(!localConfig.name || !localConfig.rootPath) ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20' : 'border-gray-200 dark:border-gray-700'} rounded-lg p-4 mb-6`}>
      <SectionHeader
        title="First, define your server"
        isExpanded={isExpanded}
        onToggle={toggleSection}
        status={getSectionStatus()}
      />
      
      {isExpanded && (
        <div className="space-y-4">
          <LocalServerForm
            name={localConfig.name}
            setName={(name) => setLocalConfig({ ...localConfig, name })}
            rootPath={localConfig.rootPath || ''}
            setRootPath={(rootPath) => setLocalConfig({ ...localConfig, rootPath })}
            onRootPathSelect={onRootPathSelect}
          />
        </div>
      )}
    </div>
  );
};

export default DefineServerSection;
