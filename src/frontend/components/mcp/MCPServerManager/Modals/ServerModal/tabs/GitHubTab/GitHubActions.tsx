'use client';

import React from 'react';
import { RepoInfo } from '../../types';
import { Box, Button } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';

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
  const { t } = useI18n();
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
          {isCloning ? t('mcp.github.processing') : t('mcp.github.reclone')}
        </Button>
      )}
      <Button
        variant="contained"
        color={cloneCompleted ? "success" : "primary"}
        onClick={handleClone}
        disabled={isCloning || !repoInfo}
      >
        {isCloning ? t('mcp.github.processing') : repoExists ? t('mcp.github.useExisting') : t('mcp.github.clone')}
      </Button>
    </Box>
  );
};

export default GitHubActions;
