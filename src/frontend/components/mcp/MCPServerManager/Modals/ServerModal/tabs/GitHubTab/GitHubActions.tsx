'use client';

import React from 'react';
import { RepoInfo } from '../../types';
import { Box, Button } from '@mui/material';

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
    <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
      <Button
        variant="contained"
        color={cloneCompleted ? "success" : "primary"}
        onClick={onClone}
        disabled={isCloning || !repoInfo}
      >
        {isCloning ? 'Processing...' : '2) Clone Repository'}
      </Button>
    </Box>
  );
};

export default GitHubActions;
