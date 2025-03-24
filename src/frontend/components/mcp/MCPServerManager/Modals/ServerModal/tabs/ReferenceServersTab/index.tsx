'use client';

import React, { useState, useEffect } from 'react';
import { TabProps, MessageState } from '../../types';
import { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp/mcp';
import RefreshIcon from '@mui/icons-material/Refresh';
import GitHubIcon from '@mui/icons-material/GitHub';
import FolderIcon from '@mui/icons-material/Folder';
import SettingsIcon from '@mui/icons-material/Settings';
import CodeIcon from '@mui/icons-material/Code';
import { useConsoleOutput } from '../LocalServerTab/hooks/useConsoleOutput';
import { 
  Alert, 
  Box, 
  Button, 
  Card, 
  CardActionArea,
  CardContent, 
  CardMedia,
  CircularProgress, 
  Divider,
  Grid, 
  Paper, 
  Stack,
  Typography,
  useTheme,
  Chip,
  Avatar
} from '@mui/material';

// Define types for server data
interface ServerInfo {
  name: string;
  description: string;
  directory: string;
  repoUrl: string;
  readmeContent?: string;
  command?: string;
  args?: string[];
  buildCommand?: string;
  installCommand?: string;
}

// Function to get a consistent gray color
const getServerColor = (theme: any): string => {
  return theme.palette.mode === 'dark' 
    ? '#424242' // Dark gray in dark mode
    : '#607d8b'; // Blue gray in light mode
};

// Create a subtle gray gradient
const getServerGradient = (theme: any): string => {
  const baseColor = theme.palette.mode === 'dark' 
    ? '#424242' // Dark gray in dark mode
    : '#607d8b'; // Blue gray in light mode
  
  const secondaryColor = theme.palette.mode === 'dark'
    ? '#303030' // Darker gray for gradient in dark mode
    : '#455a64'; // Darker blue gray in light mode
  
  return `linear-gradient(135deg, ${baseColor} 0%, ${secondaryColor} 100%)`;
};

const ReferenceServersTab: React.FC<TabProps> = ({
  onAdd,
  onClose,
  setActiveTab,
  onUpdate,
}) => {
  const theme = useTheme();
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isCloning, setIsCloning] = useState<boolean>(false);
  const [message, setMessage] = useState<MessageState | null>(null);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [mcpServersDir, setMcpServersDir] = useState<string>('');
  const [repoExists, setRepoExists] = useState<boolean>(false);
  
  // Use the console output hook for displaying command results
  const {
    consoleOutput,
    isConsoleVisible,
    setIsConsoleVisible,
    updateConsole,
    clearConsole
  } = useConsoleOutput();

  // Fetch the current working directory and check if the repo exists
  useEffect(() => {
    const initializeTab = async () => {
      setIsLoading(true);
      try {
        // Get MCP servers directory
        const cwdResponse = await fetch('/api/cwd');
        const cwdData = await cwdResponse.json();
        
        if (cwdData.success) {
          setMcpServersDir(cwdData.mcpServersDir);
          
          // Check if the modelcontextprotocol/servers repo already exists
          const repoPath = `${cwdData.mcpServersDir}/servers`;
          
          const checkResponse = await fetch('/api/git', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              action: 'exists',
              savePath: repoPath,
            }),
          });
          
          const checkResult = await checkResponse.json();
          setRepoExists(checkResult.exists);
          
          if (checkResult.exists) {
            // If repo exists, fetch server info
            await fetchServerInfo(repoPath);
          } else {
            setMessage({
              type: 'warning',
              text: 'ModelContextProtocol servers repository not found. Click "Refresh" to clone it.'
            });
          }
        }
      } catch (error) {
        console.error('Error initializing Reference Servers tab:', error);
        setMessage({
          type: 'error',
          text: `Failed to initialize: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      } finally {
        setIsLoading(false);
      }
    };
    
    initializeTab();
  }, []);
  
  // Function to clone or pull the repository
  const handleRefresh = async () => {
    setIsRefreshing(true);
    clearConsole();
    setIsConsoleVisible(true);
    updateConsole('Starting repository refresh...\n');
    
    try {
      const repoUrl = 'https://github.com/modelcontextprotocol/servers.git';
      const savePath = `${mcpServersDir}/servers`;
      
      if (repoExists) {
        // If repo exists, use 'run' action to run git pull
        updateConsole('Repository already exists. Pulling latest changes...\n');
        
        const pullResponse = await fetch('/api/git', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'run',
            savePath: savePath,
            runCommand: 'git pull',
          }),
        });
        
        const pullResult = await pullResponse.json();
        
        if (pullResult.success) {
          updateConsole(`Pull successful: ${pullResult.output || 'Repository updated'}\n`);
        } else {
          // If git pull fails, try to continue anyway
          updateConsole(`Warning: Failed to pull latest changes: ${pullResult.error}\n`);
          updateConsole('Continuing with existing repository...\n');
        }
      } else {
        // If repo doesn't exist, clone it using git clone command
        setIsCloning(true);
        updateConsole(`Cloning repository from ${repoUrl}...\n`);
        
        // First ensure the parent directory exists
        const parentDir = savePath.substring(0, savePath.lastIndexOf('/'));
        
        // The 'clone' action will handle creating parent directories, so we don't need a separate mkdir call
        
        // Use 'clone' action which works across all platforms
        const cloneResponse = await fetch('/api/git', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'clone',
            repoUrl: repoUrl,
            savePath: savePath
          }),
        });
        
        const cloneResult = await cloneResponse.json();
        
        if (cloneResult.success) {
          updateConsole(`Clone successful: ${cloneResult.output || 'Repository cloned'}\n`);
          setRepoExists(true);
        } else {
          throw new Error(`Failed to clone repository: ${cloneResult.error}`);
        }
        
        setIsCloning(false);
      }
      
      // Install dependencies and build
      updateConsole('Installing dependencies... (This can take up to several MINUTES, please be patient, do not close this window.) \n');
      
      const installResponse = await fetch('/api/git', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'install',
          savePath: savePath,
          installCommand: 'npm install',
        }),
      });
      
      const installResult = await installResponse.json();
      
      if (installResult.success) {
        updateConsole(`${installResult.output || 'Dependencies installed successfully'}\n`);
        
        // Build the servers
        updateConsole('Building servers...\n');
        
        const buildResponse = await fetch('/api/git', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'build',
            savePath: savePath,
            buildCommand: 'npm run build',
          }),
        });
        
        const buildResult = await buildResponse.json();
        
        if (buildResult.success) {
          updateConsole(`${buildResult.output || 'Build completed successfully'}\n`);
        } else {
          updateConsole(`Build warning: ${buildResult.error}\n`);
        }
      } else {
        updateConsole(`Install warning: ${installResult.error}\n`);
      }
      
      // Fetch server info
      await fetchServerInfo(savePath);
      
      setMessage({
        type: 'success',
        text: 'Repository refreshed successfully'
      });
    } catch (error) {
      console.error('Error refreshing repository:', error);
      updateConsole(`Error: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
      setMessage({
        type: 'error',
        text: `Failed to refresh repository: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    } finally {
      setIsRefreshing(false);
    }
  };
  
  // Function to fetch server information from the repo
  const fetchServerInfo = async (repoPath: string) => {
    updateConsole('Fetching server information...\n');
    
    try {
      // Get list of directories in src using cross-platform listDir action
      const srcPath = `${repoPath}/src`;
      
      // Use the platform-independent listDir action
      const listResponse = await fetch('/api/git', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'listDir',
          savePath: srcPath,
        }),
      });
      
      const listResult = await listResponse.json();
      
      if (!listResult.success) {
        throw new Error(`Failed to list directories: ${listResult.error}`);
      }
      
      // Filter for directories only and exclude hidden ones
      const directories = listResult.items
        .filter((item: { type: string; isHidden: boolean }) => 
          item.type === 'directory' && !item.isHidden)
        .map((item: { name: string; type: string }) => ({ 
          name: item.name, 
          type: item.type 
        }));
      
      updateConsole(`Found ${directories.length} server directories\n`);
      
      // Process each server directory
      const serverPromises = directories.map(async (dir: { name: string; type: string }) => {
        const serverPath = `${srcPath}/${dir.name}`;
        const readmePath = `${serverPath}/README.md`;
        
        // Try to read README.md using readFile action
        let readmeContent = '';
        let readmeSuccess = false;
        
        try {
          const readmeResponse = await fetch('/api/git', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              action: 'readFile',
              savePath: readmePath,
            }),
          });
          
          const readmeResult = await readmeResponse.json();
          
          if (readmeResult.success && readmeResult.content) {
            readmeContent = readmeResult.content;
            readmeSuccess = true;
          }
        } catch (error) {
          console.error('Error reading README with readFile action:', error);
        }
        
        // Extract server info
        const serverInfo: ServerInfo = {
          name: dir.name,
          description: '',
          directory: serverPath,
          repoUrl: `https://github.com/modelcontextprotocol/servers/tree/main/src/${dir.name}`,
        };
        
        if (readmeSuccess && readmeContent) {
          serverInfo.readmeContent = readmeContent;
          
          // Extract description from README
          const descriptionMatch = readmeContent.match(/# ([^\n]+)|^([^\n#][^\n]*)/);
          if (descriptionMatch) {
            serverInfo.description = descriptionMatch[1] || descriptionMatch[2];
          }
          
          // Try to extract command from README
          const installCommandMatch = readmeContent.match(/npm install|yarn install/);
          if (installCommandMatch) {
            serverInfo.installCommand = installCommandMatch[0];
          }
          
          const runCommandMatch = readmeContent.match(/npm (start|run dev|run serve)|node [\w\/\.-]+|npx -y @modelcontextprotocol\/[a-zA-Z0-9-_]+/);
          if (runCommandMatch) {
            serverInfo.command = runCommandMatch[0];
          }
        }
        
        return serverInfo;
      });
      
      const serverList = await Promise.all(serverPromises);
      setServers(serverList);
      
      updateConsole(`Found ${serverList.length} servers in the repository\n`);
    } catch (error) {
      console.error('Error fetching server info:', error);
      updateConsole(`Error fetching server info: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
      throw error;
    }
  };
  
  // Helper function to check if a file exists
  const hasFile = async (filePath: string): Promise<boolean> => {
    try {
      const response = await fetch('/api/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'readFile',
          savePath: filePath,
        }),
      });
      
      const result = await response.json();
      return result.success;
    } catch {
      return false;
    }
  };

  // Function to handle server selection
  const handleServerSelect = async (server: ServerInfo) => {
    try {
      // Determine if it's a TypeScript or Python server
      const isTypescript = await hasFile(`${server.directory}/package.json`);
      const isPython = await hasFile(`${server.directory}/pyproject.toml`);
      
      let command = '';
      let args: string[] = [];
      let buildCommand = '';
      let installCommand = '';
      
      if (isTypescript) {
        // For TypeScript servers
        command = 'node';
        args = ['dist/index.js'];
        buildCommand = 'npm run build';
        installCommand = 'npm install';
        
        // Try to read package.json to confirm the entry point
        try {
          const packageJsonResponse = await fetch('/api/git', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'readFile',
              savePath: `${server.directory}/package.json`,
            }),
          });
          
          const packageJsonResult = await packageJsonResponse.json();
          
          if (packageJsonResult.success) {
            const packageJson = JSON.parse(packageJsonResult.content);
            
            // Check for bin entry to find the entry point
            if (packageJson.bin) {
              let entryPoint = '';
              if (typeof packageJson.bin === 'string') {
                entryPoint = packageJson.bin;
              } else {
                // Find the entry point for this specific server
                const binKey = `mcp-server-${server.name}`;
                if (packageJson.bin[binKey]) {
                  entryPoint = packageJson.bin[binKey];
                }
              }
              
              if (entryPoint) {
                args = [entryPoint];
              }
            }
          }
        } catch (error) {
          console.error('Error reading package.json:', error);
          // Fallback to default
        }
      } else if (isPython) {
        // For Python servers
        command = 'python';
        // Convert kebab-case (brave-search) to snake_case (brave_search)
        const moduleNameSuffix = server.name.replace(/-/g, '_');
        const moduleName = `mcp_server_${moduleNameSuffix}`;
        args = ['-m', moduleName];
        buildCommand = 'pip install -e .';
        installCommand = 'pip install -r requirements.txt';
        
        // Try to read pyproject.toml to confirm the module name
        try {
          const pyprojectResponse = await fetch('/api/git', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'readFile',
              savePath: `${server.directory}/pyproject.toml`,
            }),
          });
          
          const pyprojectResult = await pyprojectResponse.json();
          
          if (pyprojectResult.success) {
            // Parse the module name from project.scripts entry
            // Extract the module name using regex: mcp-server-name = "module_name:main"
            const scriptMatch = pyprojectResult.content.match(/\[project\.scripts\][\s\S]*?mcp-server-[^=]+=\s*"([^:]+):/);
            if (scriptMatch && scriptMatch[1]) {
              args = ['-m', scriptMatch[1]];
            }
          }
        } catch (error) {
          console.error('Error reading pyproject.toml:', error);
          // Fallback to default
        }
      } else {
        // Fallback to the original behavior if we can't determine the type
        command = server.command || 'npx -y @modelcontextprotocol/server-' + server.name;
        args = [];
        buildCommand = server.buildCommand || 'npm run build';
        installCommand = server.installCommand || 'npm install';
      }
      
      // Create a configuration for the selected server with the full server directory path
      const serverConfig: MCPStdioConfig = {
        name: server.name,
        // Update the root path to point directly to the server directory
        rootPath: server.directory,
        command: command,
        args: args,
        env: {},
        disabled: false,
        autoApprove: [],
        transport: 'stdio',
        _buildCommand: buildCommand,
        _installCommand: installCommand,
      };
      
      // Update the config in the parent component
      if (onUpdate) {
        onUpdate(serverConfig);
      }
      
      // Switch to LocalServerTab for further configuration
      if (setActiveTab) {
        setActiveTab('local');
      }
    } catch (error) {
      console.error('Error configuring server:', error);
      setMessage({
        type: 'error',
        text: `Error configuring server: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
  };
  
  return (
    <Box sx={{ width: '100%' }}>
      <Stack spacing={3}>
        <Typography variant="h6" gutterBottom>
          MCP Reference Servers
        </Typography>
        
        <Box sx={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          mb: 2 
        }}>
          <Typography variant="body1">
            {repoExists 
              ? `${servers.length} servers available from the ModelContextProtocol repository` 
              : 'Repository not yet cloned. Click "Refresh" to get started.'}
          </Typography>
          
          <Button
            variant="contained"
            color="primary"
            startIcon={isRefreshing ? <CircularProgress size={20} color="inherit" /> : <RefreshIcon />}
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
        </Box>
        
        {message && (
          <Alert severity={message.type} sx={{ mb: 2 }}>
            {message.text}
          </Alert>
        )}
        
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', my: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            {isConsoleVisible && (
              <Paper
                variant="outlined"
                sx={{ 
                  p: 2, 
                  mb: 3,
                  maxHeight: '200px',
                  overflow: 'auto',
                  fontFamily: 'monospace',
                  fontSize: '0.9rem',
                  bgcolor: theme.palette.mode === 'dark' ? '#121212' : '#f5f5f5',
                }}
              >
                <Box component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap' }}>
                  {consoleOutput}
                </Box>
              </Paper>
            )}
            
            <Grid container spacing={2}>
              {servers.map((server) => (
                <Grid item xs={12} sm={6} md={4} key={server.name}>
                  <Card 
                    sx={{ 
                      height: '100%', 
                      display: 'flex', 
                      flexDirection: 'column',
                      transition: 'transform 0.2s, box-shadow 0.2s',
                      position: 'relative',
                      overflow: 'visible',
                      '&:hover': {
                        transform: 'translateY(-4px)',
                        boxShadow: 6
                      }
                    }}
                  >
                    <CardActionArea 
                      sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}
                      onClick={() => handleServerSelect(server)}
                    >
                      {/* Integrated header section */}
                      <Box sx={{ 
                        p: 2, 
                        display: 'flex', 
                        alignItems: 'center',
                        borderBottom: '1px solid',
                        borderColor: 'divider',
                        background: getServerGradient(theme)
                      }}>
                        {/* Server avatar/icon with first letter */}
                        <Avatar 
                          sx={{ 
                            bgcolor: getServerColor(theme), 
                            color: '#fff',
                            mr: 2,
                            boxShadow: 1
                          }}
                        >
                          {server.name.charAt(0).toUpperCase()}
                        </Avatar>
                        
                        <Box sx={{ flexGrow: 1 }}>
                          <Typography variant="h6" component="div" sx={{ 
                            textTransform: 'capitalize',
                            color: '#fff',
                            textShadow: '0px 1px 2px rgba(0,0,0,0.2)'
                          }}>
                            {server.name.replace(/-/g, ' ')}
                          </Typography>
                          <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <Chip 
                              size="small" 
                              icon={<GitHubIcon />} 
                              label="MCP" 
                              sx={{ 
                                mr: 1, 
                                bgcolor: 'rgba(255,255,255,0.2)', 
                                color: '#fff',
                                '& .MuiChip-icon': { 
                                  color: '#fff' 
                                }
                              }}
                            />
                            <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.8)' }}>
                              Reference Server
                            </Typography>
                          </Box>
                        </Box>
                      </Box>

                      {/* Card content */}
                      <CardContent sx={{ flexGrow: 1, pt: 2 }}>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                          {server.description || `MCP Reference Server for ${server.name.replace(/-/g, ' ')}`}
                        </Typography>
                      </CardContent>
                    </CardActionArea>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </>
        )}
      </Stack>
    </Box>
  );
};

export default ReferenceServersTab;
