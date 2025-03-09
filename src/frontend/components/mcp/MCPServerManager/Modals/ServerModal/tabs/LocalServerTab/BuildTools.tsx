'use client';

import React from 'react';

interface BuildToolsProps {
  installCommand: string;
  setinstallCommand: (script: string) => void;
  buildCommand: string;
  setBuildCommand: (command: string) => void;
  onInstall: () => Promise<void>;
  onBuild: () => Promise<void>;
  isInstalling: boolean;
  isBuilding: boolean;
  installCompleted: boolean;
  buildCompleted: boolean;
}

const BuildTools: React.FC<BuildToolsProps> = ({
  installCommand,
  setinstallCommand,
  buildCommand,
  setBuildCommand,
  onInstall,
  onBuild,
  isInstalling,
  isBuilding,
  installCompleted,
  buildCompleted
}) => {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">
          Install Script
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={installCommand}
            onChange={e => setinstallCommand(e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg"
          />
          <button
            type="button"
            onClick={onInstall}
            disabled={isInstalling}
            className={`px-4 py-2 ${installCompleted ? 'bg-green-500' : 'bg-blue-500'} text-white rounded-lg`}
          >
            {isInstalling ? 'Installing...' : '1) Install Dependencies'}
          </button>
        </div>
      </div>
      
      <div>
        <label className="block text-sm font-medium mb-1">
          Build Command
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={buildCommand}
            onChange={e => setBuildCommand(e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg"
          />
          <button
            type="button"
            onClick={onBuild}
            disabled={isBuilding}
            className={`px-4 py-2 ${buildCompleted ? 'bg-green-500' : 'bg-blue-500'} text-white rounded-lg`}
          >
            {isBuilding ? 'Building...' : '2) Build Server'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BuildTools;
