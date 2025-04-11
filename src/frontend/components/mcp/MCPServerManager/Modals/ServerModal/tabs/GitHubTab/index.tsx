'use client';

import React, { useState, useEffect } from 'react';
import Alert from '@mui/material/Alert';
import { TabProps, RepoInfo, MessageState } from '../../types';
import GitHubForm from './GitHubForm';
import GitHubActions from './GitHubActions';
import { validateGitHubUrl, cloneRepository } from '../../utils/gitHubUtils';
import { parseEnvVariables } from '../../utils/configUtils';
import { detectRepositoryConfig } from '../../utils/configDetection';
import { createEmptyConfigWarningMessage } from '../../utils/errorHandling';
import { MCPServerState } from '@/shared/types';
import { MCPServerConfig, parseServerConfig } from '@/utils/mcp'; // Import parseServerConfig
import path from 'path';
import { Box, Paper, Stack, Typography } from '@mui/material';

const GitHubTab: React.FC<TabProps> = ({
  initialConfig,
  onAdd,
  onUpdate,
  onClose,
  setActiveTab
}) => {
  const [githubUrl, setGithubUrl] = useState<string>('');
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [savePath, setSavePath] = useState<string>('');
  const [showCloneButton, setShowCloneButton] = useState<boolean>(false);
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const [isCloning, setIsCloning] = useState<boolean>(false);
  const [parseCompleted, setParseCompleted] = useState<boolean>(false);
  const [cloneCompleted, setCloneCompleted] = useState<boolean>(false);
  const [message, setMessage] = useState<MessageState | null>(null);
  const [clonedRepoPath, setClonedRepoPath] = useState<string>('');
  const [parsedConfig, setParsedConfig] = useState<Partial<MCPServerConfig> | null>(null);
  const [mcpServersDir, setMcpServersDir] = useState<string>('');
  
  // Fetch the current working directory and mcp-servers directory when component mounts
  useEffect(() => {
    const fetchCwdInfo = async () => {
      try {
        const response = await fetch('/api/cwd');
        const data = await response.json();
        
        if (data.success && data.mcpServersDir) {
          setMcpServersDir(data.mcpServersDir);
        } else {
          console.error('Failed to get mcp-servers directory:', data.error);
        }
      } catch (error) {
        console.error('Error fetching cwd information:', error);
      }
    };
    
    fetchCwdInfo();
  }, []);

  const handleValidate = async () => {
    setIsValidating(true);
    setMessage(null);
    
    const result = await validateGitHubUrl(githubUrl);
    
    setRepoInfo(result.repoInfo);
    setMessage(result.message);
    setShowCloneButton(result.showCloneButton);
    
    if (result.repoInfo) {
      // If we don't have mcpServersDir yet, fetch it now
      if (!mcpServersDir) {
        try {
          const response = await fetch('/api/cwd');
          const data = await response.json();
          
          if (data.success && data.mcpServersDir) {
            setMcpServersDir(data.mcpServersDir);
            // Set default save path with the dynamically fetched path
            const repoPath = path.join(data.mcpServersDir, result.repoInfo.repo);
            setSavePath(repoPath);
          } else {
            console.error('Failed to get mcp-servers directory:', data.error);
            // Fallback to a relative path if API fails
            setSavePath(`./mcp-servers/${result.repoInfo.repo}`);
          }
        } catch (error) {
          console.error('Error fetching cwd information:', error);
          // Fallback to a relative path if API fails
          setSavePath(`./mcp-servers/${result.repoInfo.repo}`);
        }
      } else {
        // Use the already fetched mcpServersDir
        const repoPath = path.join(mcpServersDir, result.repoInfo.repo);
        setSavePath(repoPath);
      }
      
      setParseCompleted(true);
    }
    
    setIsValidating(false);
  };

  const handleClone = async () => {
    if (!repoInfo) return;
    
    setIsCloning(true);
    setMessage({
      type: 'success',
      text: 'Cloning repository...'
    });
    
    try {
      // Clone the repository
      const cloneResult = await cloneRepository(githubUrl, repoInfo, savePath);
      
      if (!cloneResult.success || !cloneResult.clonedRepoPath) {
        setMessage(cloneResult.message);
        setIsCloning(false);
        return;
      }
      
      // Store the cloned repository path
      const repoPath = cloneResult.clonedRepoPath;
      setClonedRepoPath(repoPath);
      
      // Parse .env.example if it exists
      let envFromExample = {};
      if (cloneResult.envExample && typeof cloneResult.envExample === 'string') {
        envFromExample = parseEnvVariables(cloneResult.envExample);
        console.log('Parsed environment variables from .env.example:', envFromExample);
      }
      
      // Detect repository configuration
      const detectionResult = await detectRepositoryConfig(
        repoPath,
        repoInfo.repo,
        repoInfo.owner
      );
      
      // Update message with detection result
        // Update message with initial detection result (might be overwritten by README parsing)
        setMessage(detectionResult.message);
        
        let finalConfig: Partial<MCPServerConfig> = {};
        let finalMessage: MessageState | null = detectionResult.message;

        if (detectionResult.success && detectionResult.config) {
          console.log('GitHubTab: Initial detection successful. Merging config.');
          // Merge env variables from detection and .env.example (with .env.example taking precedence)
          finalConfig = {
            ...detectionResult.config,
            rootPath: repoPath, // Ensure rootPath is set
          env: {
            ...(detectionResult.config.env || {}),
            ...envFromExample // .env.example values override detected values
          }
        };
        finalMessage = detectionResult.message; // Keep the success message from detection
        
      } else {
        console.log('GitHubTab: Initial detection failed. Attempting README parsing fallback.');
        // Initial detection failed, try parsing README.md as a fallback
        const defaultConfig: Partial<MCPServerConfig> = {
          name: repoInfo.repo,
          transport: 'stdio',
          command: '',
          args: [],
          env: envFromExample, // Start with env from .env.example
          disabled: false,
          autoApprove: [],
          rootPath: repoPath,
          _buildCommand: '',
          _installCommand: '',
        };

        try {
          // Construct the relative path for README.md
          const readmeRelativePath = path.join(repoInfo.repo, 'README.md');
          console.log(`GitHubTab: Reading README.md from relative path: ${readmeRelativePath}`);
          
          // Fetch README content
          const readmeResponse = await fetch('/api/git', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'readFile',
              savePath: readmeRelativePath // Use relative path
            })
          });
          
          const readmeData = await readmeResponse.json();
          
          if (readmeData.success && readmeData.content) {
            console.log('GitHubTab: README.md read successfully. Parsing content.');
            // Parse the README content
            const readmeParseResult = parseServerConfig(readmeData.content, true, repoInfo.repo);
            
            console.log('GitHubTab: README parse result:', readmeParseResult);
            
            // Merge default config, README config, and .env.example
            finalConfig = {
              ...defaultConfig,
              ...readmeParseResult.config, // Parsed config from README
              rootPath: repoPath, // Ensure rootPath is correct
              env: { // Merge env: default -> readme -> .env.example
                ...(defaultConfig.env || {}),
                ...(readmeParseResult.config?.env || {}),
                ...envFromExample 
              },
              // Ensure build/install commands from README override defaults
              _buildCommand: readmeParseResult.config?._buildCommand || defaultConfig._buildCommand,
              _installCommand: readmeParseResult.config?._installCommand || defaultConfig._installCommand,
            };
            
            // Update message based on README parsing result - use 'warning' if only partially extracted
            finalMessage = readmeParseResult.message || { type: 'warning', text: 'Configuration partially extracted from README.md. Please review.' };
            
          } else {
            console.log('GitHubTab: Failed to read or parse README.md. Using default config.');
            // Failed to read README, use the default config and original warning
            finalConfig = defaultConfig;
            finalMessage = createEmptyConfigWarningMessage(detectionResult.language);
          }
        } catch (readmeError) {
          console.error('GitHubTab: Error reading or parsing README.md:', readmeError);
          // Error during README processing, use default config and show error
          finalConfig = defaultConfig;
          finalMessage = { type: 'error', text: `Error processing README.md: ${readmeError instanceof Error ? readmeError.message : 'Unknown error'}` };
        }
      }
      
      // Store the final config (either from detection or README fallback)
      setParsedConfig(finalConfig);
      setMessage(finalMessage); // Set the final message state

      // Pass the config to the parent component before switching tabs
      if (onUpdate && finalConfig.name) { // Ensure name is present before updating
        onUpdate(finalConfig as MCPServerConfig);
      }
      
      // Always switch to the local tab
      if (setActiveTab) {
        setActiveTab('local');
      }
      
      setCloneCompleted(true);
    } catch (error) {
      console.error('Error during repository cloning or configuration detection:', error);
      setMessage({
        type: 'error',
        text: `Error processing repository: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    } finally {
      setIsCloning(false);
    }
  };

  return (
    <Paper elevation={0} sx={{ p: 0 }}>
      <Stack spacing={3}>
        <Typography variant="h6" gutterBottom>
          Import from GitHub or MCP Platform
        </Typography>
        <GitHubForm
          githubUrl={githubUrl}
          setGithubUrl={setGithubUrl}
          savePath={savePath}
          setSavePath={setSavePath}
          repoInfo={repoInfo}
          isValidating={isValidating}
          parseCompleted={parseCompleted}
          onValidate={handleValidate}
        />
        
        <GitHubActions
          showCloneButton={showCloneButton}
          isCloning={isCloning}
          cloneCompleted={cloneCompleted}
          repoInfo={repoInfo}
          onClone={handleClone}
        />

        {message && (
          <Box>
            <Alert severity={message.type}>
              {message.text}
            </Alert>
          </Box>
        )}
      </Stack>
    </Paper>
  );
};

export default GitHubTab;
