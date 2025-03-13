import { RepoInfo, MessageState } from '../types';

// Helper functions to detect platform URLs
const isGlamaUrl = (url: string): boolean => {
  return url.includes('glama.ai/mcp/servers/');
};

const isSmitheryUrl = (url: string): boolean => {
  return url.includes('smithery.ai/server/');
};

const isMcpSoUrl = (url: string): boolean => {
  return url.includes('mcp.so/server/');
};

// Function to extract GitHub URL from platform pages
const extractGitHubUrlFromPlatform = async (
  platformUrl: string
): Promise<string | null> => {
  try {
    // Call the backend API to extract the GitHub URL
    const response = await fetch('/api/git', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'extractGitHubUrl',
        platformUrl
      }),
    });
    
    if (!response.ok) {
      throw new Error('Failed to extract GitHub URL from platform');
    }
    
    const result = await response.json();
    
    if (result.success && result.githubUrl) {
      return result.githubUrl;
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting GitHub URL from platform:', error);
    return null;
  }
};

export const validateGitHubUrl = async (
  inputUrl: string
): Promise<{
  repoInfo: RepoInfo | null;
  message: MessageState | null;
  showCloneButton: boolean;
}> => {
  try {
    let githubUrl = inputUrl;
    
    // Check if the URL is from a platform and extract the GitHub URL if needed
    if (isGlamaUrl(inputUrl) || isSmitheryUrl(inputUrl) || isMcpSoUrl(inputUrl)) {
      // Show loading message
      const platformType = isGlamaUrl(inputUrl) ? 'Glama' : 
                          isSmitheryUrl(inputUrl) ? 'Smithery' : 'MCP.so';
      
      // Return early with a loading message
      const loadingResult = {
        repoInfo: null,
        message: {
          type: 'warning' as const,
          text: `Extracting GitHub URL from ${platformType}...`
        },
        showCloneButton: false
      };
      
      // Extract the GitHub URL from the platform
      const extractedUrl = await extractGitHubUrlFromPlatform(inputUrl);
      
      if (!extractedUrl) {
        throw new Error(`Could not extract GitHub URL from ${platformType}`);
      }
      
      // Use the extracted GitHub URL
      githubUrl = extractedUrl;
    }
    
    // Validate URL format
    const url = new URL(githubUrl);
    if (url.hostname !== 'github.com') {
      throw new Error('Not a GitHub URL');
    }

    // Extract owner and repo, handling file URLs
    let owner, repo;
    
    // Check if URL contains /blob/ or /tree/ which indicates it's a file or directory URL
    const blobMatch = githubUrl.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/(?:blob|tree)\/.*$/);
    if (blobMatch) {
      owner = blobMatch[1];
      repo = blobMatch[2];
    } else {
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length >= 2) {
        owner = pathParts[0];
        repo = pathParts[1];
      } else {
        throw new Error('Invalid repository path');
      }
    }
    
    // Validate repository by fetching API data
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
    
    if (!response.ok) {
      throw new Error('Repository not found or not accessible');
    }
    
    const repoData = await response.json();
    
    // Check if it's an MCP server by looking for package.json
    const contentsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents`);
    if (!contentsResponse.ok) {
      throw new Error('Could not fetch repository contents');
    }
    
    const contents = await contentsResponse.json();
    
    return {
      repoInfo: { 
        owner, 
        repo, 
        valid: true,
        contents
      },
      message: {
        type: 'success',
        text: `Valid repository: ${owner}/${repo}`
      },
      showCloneButton: true
    };
  } catch (error) {
    console.error('GitHub parsing error:', error);
    return {
      repoInfo: null,
      message: {
        type: 'error',
        text: (error as Error).message || 'Invalid GitHub URL. Please enter a valid repository URL.'
      },
      showCloneButton: false
    };
  }
};

export const cloneRepository = async (
  githubUrl: string,
  repoInfo: RepoInfo,
  savePath: string
): Promise<{
  success: boolean;
  message: MessageState;
  clonedRepoPath?: string;
  envExample?: string;
}> => {
  try {
    // Prepare the repository URL - extract base repo URL if it's a file URL
    let repoUrl = githubUrl;
    
    // Check if URL contains /blob/ or /tree/ which indicates it's a file or directory URL
    const blobMatch = repoUrl.match(/^(https:\/\/github\.com\/[^\/]+\/[^\/]+)\/(?:blob|tree)\/.*$/);
    if (blobMatch) {
      repoUrl = blobMatch[1];
    }
    
    const gitCloneUrl = repoUrl.endsWith('.git') ? repoUrl : `${repoUrl}.git`;
    
    // Normalize path by replacing backslashes with forward slashes
    const normalizedPath = savePath.replace(/\\/g, '/');
    
    // Call the server-side git API to clone the repository
    const response = await fetch('/api/git', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'clone',
        repoUrl: gitCloneUrl,
        savePath: normalizedPath,
        branch: undefined // Optional: specify a branch
      }),
    });
    
    const result = await response.json();
    if (!response.ok && !('exists' in result)) {
      throw new Error(result.error || 'Failed to clone repository');
    }
    
    // Normalize path by replacing backslashes with forward slashes
    const normalizedRepoPath = result.relativePath.replace(/\\/g, '/');
    
    return {
      success: true,
      message: {
        type: 'success',
        text: 'Repository cloned successfully.'
      },
      clonedRepoPath: normalizedRepoPath,
      envExample: result.envExample
    };
  } catch (error) {
    console.error('Error cloning repository:', error);
    
    // Check if the error message contains "directory already exist"
    const errorMessage = (error as Error).message || '';
    if (errorMessage.includes('directory already exist')) {
      // Extract the path from the error message if possible
      const pathMatch = errorMessage.match(/directory already exist: (.+?)(,|\.|$)/);
      const extractedPath = pathMatch ? pathMatch[1] : savePath;
      
      return {
        success: true,
        message: {
          type: 'warning',
          text: errorMessage
        },
        clonedRepoPath: extractedPath.replace(/\\/g, '/'),
        envExample: undefined
      };
    }
    
    return {
      success: false,
      message: {
        type: 'error',
        text: errorMessage || 'Error cloning repository. Please try again or configure manually.'
      },
      envExample: undefined
    };
  }
};

export const runRepository = async (
  repoPath: string,
  runCommand: string
): Promise<{
  success: boolean;
  message: MessageState;
  commandOutput?: string;
}> => {
  try {
    // Normalize path by replacing backslashes with forward slashes
    const normalizedPath = repoPath.replace(/\\/g, '/');
    
    // Call the server-side git API to run the command in the repository
    const response = await fetch('/api/git', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'run',
        savePath: normalizedPath,
        runCommand: runCommand,
      }),
    });
    
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to run command in repository');
    }
    
    return {
      success: true,
      message: {
        type: 'success',
        text: 'Command executed successfully.'
      },
      commandOutput: result.commandOutput
    };
  } catch (error) {
    console.error('Error running command in repository:', error);
    
    return {
      success: false,
      message: {
        type: 'error',
        text: (error as Error).message || 'Error executing command. Please try again.'
      }
    };
  }
};

export const fetchReadmeContent = async (
  owner: string,
  repo: string,
  repoPath: string
): Promise<string | null> => {
  // Try to fetch README content directly from GitHub API first
  try {
    // Fetch README from GitHub API
    const githubReadmeResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`);
    
    if (githubReadmeResponse.ok) {
      const githubReadmeData = await githubReadmeResponse.json();
      
      // GitHub API returns README content as base64 encoded
      if (githubReadmeData.content) {
        // Decode base64 content
        return atob(githubReadmeData.content.replace(/\n/g, ''));
      }
    }
  } catch (githubReadmeError) {
    console.error('Error fetching README from GitHub API:', githubReadmeError);
  }
  
  // If we couldn't get README from GitHub API, try to read it from the cloned repository
  try {
    // Call the server-side API to read the README file
    const readmeResponse = await fetch('/api/git', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'readFile',
        path: `${repoPath}/README.md`,
      }),
    });
    
    if (readmeResponse.ok) {
      const readmeResult = await readmeResponse.json();
      if (readmeResult.content) {
        return readmeResult.content;
      }
    }
  } catch (localReadmeError) {
    console.error('Error reading local README:', localReadmeError);
  }
  
  return null;
};
