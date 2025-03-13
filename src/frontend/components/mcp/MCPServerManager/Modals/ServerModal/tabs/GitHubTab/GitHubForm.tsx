'use client';

import React, { useState, useEffect } from 'react';
import FolderIcon from '@mui/icons-material/Folder';
import { RepoInfo, MessageState } from '../../types';
import { 
  Box, 
  Button, 
  TextField, 
  Typography, 
  Stack, 
  IconButton,
  InputAdornment
} from '@mui/material';
import { useThemeUtils } from '@/frontend/utils/theme';

interface GitHubFormProps {
  githubUrl: string;
  setGithubUrl: (url: string) => void;
  savePath: string;
  setSavePath: (path: string) => void;
  repoInfo: RepoInfo | null;
  isValidating: boolean;
  parseCompleted: boolean;
  onValidate: () => Promise<void>;
}

const GitHubForm: React.FC<GitHubFormProps> = ({
  githubUrl,
  setGithubUrl,
  savePath,
  setSavePath,
  repoInfo,
  isValidating,
  parseCompleted,
  onValidate
}) => {
  const [mcpServersDir, setMcpServersDir] = useState<string>('');
  const { getThemeColor } = useThemeUtils();

  // Fetch the mcp-servers directory path from the API when the component mounts
  useEffect(() => {
    const fetchCwd = async () => {
      try {
        const response = await fetch('/api/cwd');
        const data = await response.json();
        
        if (data.success && data.mcpServersDir) {
          setMcpServersDir(data.mcpServersDir);
        } else {
          console.error('Failed to get mcp-servers directory path:', data.error);
        }
      } catch (error) {
        console.error('Error fetching current working directory:', error);
      }
    };

    fetchCwd();
  }, []);
  
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          GitHub Repository URL or MCP Server URL
        </Typography>
        <TextField
          fullWidth
          value={githubUrl}
          onChange={e => setGithubUrl(e.target.value)}
          placeholder="GitHub, Glama, Smithery, or MCP.so URL"
          helperText="You can paste URLs from GitHub, Glama, Smithery, or MCP.so"
          variant="outlined"
          size="small"
        />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
          <Button
            variant="contained"
            color={parseCompleted ? "success" : "primary"}
            onClick={onValidate}
            disabled={isValidating}
          >
            {isValidating ? 'Validating...' : '1) Parse'}
          </Button>
        </Box>
      </Box>

      {repoInfo?.valid && (
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Where to save the repository?
          </Typography>
          <TextField
            fullWidth
            value={savePath}
            onChange={e => setSavePath(e.target.value)}
            variant="outlined"
            size="small"
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={async () => {
                      try {
                        // @ts-ignore - window.showDirectoryPicker is experimental
                        const dirHandle = await window.showDirectoryPicker();
                        
                        // Use the mcp-servers directory path from the API + the selected directory name
                        // This makes the path dynamic and works regardless of where the app is installed
                        const absolutePath = mcpServersDir 
                          ? `${mcpServersDir}/${dirHandle.name}`
                          : `${dirHandle.name}`;
                        
                        // Normalize path by replacing backslashes with forward slashes
                        const normalizedPath = absolutePath.replace(/\\/g, '/');
                        setSavePath(normalizedPath);
                      } catch (error) {
                        console.error('Failed to select folder:', error);
                      }
                    }}
                    edge="end"
                  >
                    <FolderIcon />
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />
        </Box>
      )}
    </Stack>
  );
};

export default GitHubForm;
