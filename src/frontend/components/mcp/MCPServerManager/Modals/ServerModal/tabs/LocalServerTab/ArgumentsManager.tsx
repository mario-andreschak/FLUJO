'use client';

import React from 'react';
import FolderIcon from '@mui/icons-material/Folder';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import { MessageState } from '../../types';

interface ArgumentsManagerProps {
  args: string[];
  onArgChange: (index: number, value: string) => void;
  onAddArg: () => void;
  onRemoveArg: (index: number) => void;
  onFolderSelect: (index: number) => void;
  onParseReadme: () => Promise<void>;
  onParseClipboard: () => Promise<void>;
  isParsingReadme: boolean;
}

const ArgumentsManager: React.FC<ArgumentsManagerProps> = ({
  args,
  onArgChange,
  onAddArg,
  onRemoveArg,
  onFolderSelect,
  onParseReadme,
  onParseClipboard,
  isParsingReadme
}) => {
  return (
    <div className="relative">
      <div className="flex justify-between items-center mb-1">
        <label className="block text-sm font-medium">Arguments</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onParseReadme}
            disabled={isParsingReadme}
            className="flex items-center px-2 py-1 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <ContentPasteIcon sx={{ width: 16, height: 16, marginRight: 0.5 }} />
            Parse README
          </button>
          <button
            type="button"
            onClick={onParseClipboard}
            className="flex items-center px-2 py-1 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <ContentPasteIcon sx={{ width: 16, height: 16, marginRight: 0.5 }} />
            Parse from Clipboard
          </button>
        </div>
      </div>
      <div className="space-y-2">
        {args.map((arg, index) => (
          <div key={index} className="flex gap-2">
            <input
              type="text"
              value={arg}
              onChange={e => onArgChange(index, e.target.value)}
              className="flex-1 px-3 py-2 border rounded-lg"
            />
            <button
              type="button"
              onClick={() => onFolderSelect(index)}
              className="px-3 py-2 border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <FolderIcon sx={{ width: 20, height: 20 }} />
            </button>
            <button
              type="button"
              onClick={() => onRemoveArg(index)}
              className="px-3 py-2 border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <DeleteIcon sx={{ width: 20, height: 20 }} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={onAddArg}
          className="flex items-center px-3 py-2 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          <AddIcon sx={{ width: 16, height: 16, marginRight: 0.5 }} />
          Add Argument
        </button>
      </div>
    </div>
  );
};

export default ArgumentsManager;
