'use client';

import React from 'react';
import { RepoInfo } from '../../types';

interface GitHubActionsProps {
  showCloneButton: boolean;
  isCloning: boolean;
  cloneCompleted: boolean;
  repoInfo: RepoInfo | null;
  onClone: () => Promise<void>;
}

const GitHubActions: React.FC<GitHubActionsProps> = ({
  showCloneButton,
  isCloning,
  cloneCompleted,
  repoInfo,
  onClone
}) => {
  if (!showCloneButton) return null;

  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={onClone}
        disabled={isCloning || !repoInfo}
        className={`px-4 py-2 ${cloneCompleted ? 'bg-green-500' : 'bg-blue-500'} text-white rounded-lg`}
      >
        {isCloning ? 'Processing...' : '2) Clone Repository'}
      </button>
    </div>
  );
};

export default GitHubActions;
