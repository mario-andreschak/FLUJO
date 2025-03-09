'use client';

import React from 'react';
import FolderIcon from '@mui/icons-material/Folder';

interface LocalServerFormProps {
  name: string;
  setName: (name: string) => void;
  rootPath: string;
  setRootPath: (rootPath: string) => void;
  onRootPathSelect: () => void;
}

const LocalServerForm: React.FC<LocalServerFormProps> = ({
  name,
  setName,
  rootPath,
  setRootPath,
  onRootPathSelect
}) => {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">
          Server Name
        </label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full px-3 py-2 border rounded-lg"
          placeholder="my-mcp-server"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          MCP Server Root Path
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={rootPath}
            onChange={e => setRootPath(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg"
            placeholder="/path/to/server/root"
          />
          <button
            type="button"
            onClick={onRootPathSelect}
            className="px-3 py-2 border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <FolderIcon sx={{ width: 20, height: 20 }} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default LocalServerForm;
