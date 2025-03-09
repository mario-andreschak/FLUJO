'use client';

import React, { useState, useEffect } from 'react';
import FolderIcon from '@mui/icons-material/Folder';
import { RepoInfo, MessageState } from '../../types';

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
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">
          GitHub Repository URL
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={githubUrl}
            onChange={e => setGithubUrl(e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg"
            placeholder="https://github.com/username/repository"
          />
          <button
            type="button"
            onClick={onValidate}
            disabled={isValidating}
            className={`px-4 py-2 ${parseCompleted ? 'bg-green-500' : 'bg-blue-500'} text-white rounded-lg`}
          >
            {isValidating ? 'Validating...' : '1) Parse'}
          </button>
        </div>
      </div>

      {repoInfo?.valid && (
        <div>
          <label className="block text-sm font-medium mb-1">
            Where to save the repository?
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={savePath}
              onChange={e => setSavePath(e.target.value)}
              className="flex-1 px-3 py-2 border rounded-lg"
            />
            <button
              type="button"
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
              className="px-3 py-2 border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <FolderIcon sx={{ width: 20, height: 20 }} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GitHubForm;
