'use client';

import React from 'react';
import { RepoInfo } from '../../types';
import { Box, Button } from '@mui/material';

interface GitHubActionsProps {
  showCloneButton: boolean;
  isCloning: boolean;
  cloneCompleted: boolean;
  repoInfo: RepoInfo | null;
  repoExists?: boolean;
  onClone: (forceClone?: boolean) => Promise<void>;
}

const GitHubActions: React.FC<GitHubActionsProps> = ({
  showCloneButton,
  isCloning,
  cloneCompleted,
  repoInfo,
  repoExists,
  onClone
}) => {
  if (!showCloneButton) return null;

  // Handle regular clone (no force)
  const handleClone = () => {
    onClone(false);
  };

  // Handle force clone (re-clone)
  const handleForceClone = () => {
    onClone(true);
  };

  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
      {repoExists && (
        <Button
          variant="outlined"
          color="warning"
          onClick={handleForceClone}
          disabled={isCloning || !repoInfo}
        >
          {isCloning ? 'Processing...' : 'Re-clone (Force)'}
        </Button>
      )}
      <Button
        variant="contained"
        color={cloneCompleted ? "success" : "primary"}
        onClick={handleClone}
        disabled={isCloning || !repoInfo}
      >
        {isCloning ? 'Processing...' : repoExists ? 'Use Existing' : '2) Clone Repository'}
      </Button>
    </Box>
  );
};

export default GitHubActions;
