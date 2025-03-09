'use client';

import React from 'react';
import BuildTools from '../BuildTools';
import SectionHeader from './SectionHeader';

interface BuildSectionProps {
  installCommand: string;
  setInstallCommand: (command: string) => void;
  buildCommand: string;
  setBuildCommand: (command: string) => void;
  onInstall: () => Promise<void>;
  onBuild: () => Promise<void>;
  isInstalling: boolean;
  isBuilding: boolean;
  installCompleted: boolean;
  buildCompleted: boolean;
  isExpanded: boolean;
  toggleSection: () => void;
}

const BuildSection: React.FC<BuildSectionProps> = ({
  installCommand,
  setInstallCommand,
  buildCommand,
  setBuildCommand,
  onInstall,
  onBuild,
  isInstalling,
  isBuilding,
  installCompleted,
  buildCompleted,
  isExpanded,
  toggleSection
}) => {
  // Determine section status based on build/install state
  const getSectionStatus = () => {
    if (installCompleted && buildCompleted) {
      return 'success';
    } else if (installCompleted || buildCompleted) {
      return 'warning';
    } else if (isInstalling || isBuilding) {
      return 'loading';
    }
    return 'default';
  };

  return (
    <div className={`bg-gray-50 dark:bg-gray-800 border rounded-lg p-4 mb-6 
      ${installCompleted && buildCompleted ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20' : 
        (installCompleted || buildCompleted) ? 'border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20' : 
        (isInstalling || isBuilding) ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20' :
        'border-gray-200 dark:border-gray-700'}`}>
      <SectionHeader
        title="Second, install and build"
        isExpanded={isExpanded}
        onToggle={toggleSection}
        status={getSectionStatus()}
      />
      
      {isExpanded && (
        <BuildTools
          installCommand={installCommand}
          setinstallCommand={setInstallCommand}
          buildCommand={buildCommand}
          setBuildCommand={setBuildCommand}
          onInstall={onInstall}
          onBuild={onBuild}
          isInstalling={isInstalling}
          isBuilding={isBuilding}
          installCompleted={installCompleted}
          buildCompleted={buildCompleted}
        />
      )}
    </div>
  );
};

export default BuildSection;
