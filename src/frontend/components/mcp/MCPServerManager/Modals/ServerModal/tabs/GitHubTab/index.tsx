'use client';

import React, { useState, useEffect } from 'react';
import Alert from '@mui/material/Alert';
import { TabProps, RepoInfo, MessageState } from '../../types';
import GitHubForm from './GitHubForm';
import GitHubActions from './GitHubActions';
import { validateGitHubUrl, cloneRepository, fetchReadmeContent } from '../../utils/gitHubUtils';
import { parseConfigFromReadme, parseEnvVariables } from '../../utils/configUtils';
import { MCPServerState } from '@/shared/types';
import { MCPServerConfig } from '@/utils/mcp';
import path from 'path';


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
    
    const result = await cloneRepository(githubUrl, repoInfo, savePath);
    
    setMessage(result.message);
    
    if (result.success && result.clonedRepoPath) {
      // Store the .env.example content if it exists
      const envExampleContent = result.envExample;
      // Ensure we have an absolute path
      setClonedRepoPath(result.clonedRepoPath);
      
      // Try to fetch and parse README content
      if (repoInfo) {
        const readmeContent = await fetchReadmeContent(
          repoInfo.owner,
          repoInfo.repo,
          result.clonedRepoPath // Use the processed absolute path
        );
        
        if (readmeContent) {
          // Default config to use if README parsing fails
          const defaultConfig: MCPServerConfig = {
            name: repoInfo.repo,
            transport: 'stdio', // default to stdio. TODO : figure out if websocket or stdio server
            command: '',
            args: [],
            env: {},
            disabled: false,
            autoApprove: [],
            rootPath: result.clonedRepoPath,
            _buildCommand: '',
            _installCommand: '',
          };
          
          const parseResult = await parseConfigFromReadme(
            readmeContent,
            defaultConfig,
            repoInfo.repo // Pass the repository name for path processing
          );
          
          // Parse .env.example if it exists
          let envFromExample = {};
          if (envExampleContent && typeof envExampleContent === 'string') {
            envFromExample = parseEnvVariables(envExampleContent);
            console.log('Parsed environment variables from .env.example:', envFromExample);
          }
          
          // Store the parsed config in state for the parent component to access
          if (parseResult.config) {

            if(parseResult.config.transport == 'stdio'){

          // Merge env variables from README and .env.example (with .env.example taking precedence)
          const configWithCommands = {
            ...parseResult.config,
            rootPath: result.clonedRepoPath, // Ensure rootPath is set
            env: {
              ...(parseResult.config.env || {}),
              ...envFromExample // .env.example values override README values
            }
          };
            
            setParsedConfig(configWithCommands);
            
            
            // Pass the config to the parent component before switching tabs
            if (onUpdate && parseResult.config.name && parseResult.config.command && parseResult.config.args) {
              // Cast to any to avoid type errors since we've verified required fields exist
              onUpdate(configWithCommands as any);
            }
          }

            // Always switch to the local tab with the parsed config
            // so the user can install and build the repository first
            if (setActiveTab) {
              // Switch to local tab without adding the server yet
              // This allows the user to manually install dependencies and build before adding
              setActiveTab('local');
            }
          } else {
            // If no config was parsed, still switch to local tab
            if (setActiveTab) {
              setActiveTab('local');
            }
          }
        } else {
          // Parse .env.example if it exists
          let envFromExample = {};
          if (envExampleContent && typeof envExampleContent === 'string') {
            envFromExample = parseEnvVariables(envExampleContent);
            console.log('Parsed environment variables from .env.example:', envFromExample);
          }
          
          // Use the default config without adding specific build/install commands
          // const configWithCommands: MCPServerConfig = {
          //   ...{ }
          // };
          
          // // Store the config in state
          // setParsedConfig(configWithCommands);
          
          // Pass the config to the parent component
          // if (onUpdate) {
          //   onUpdate(configWithCommands as any);
          // }
          
          // Switch to local tab with default config
          if (setActiveTab) {
            setActiveTab('local');
          }
        }
      }
      
      setCloneCompleted(true);
    }
    
    setIsCloning(false);
  };

  return (
    <div className="space-y-4">
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
        <div className="mb-4">
          <Alert severity={message.type}>
            {message.text}
          </Alert>
        </div>
      )}
    </div>
  );
};

export default GitHubTab;
