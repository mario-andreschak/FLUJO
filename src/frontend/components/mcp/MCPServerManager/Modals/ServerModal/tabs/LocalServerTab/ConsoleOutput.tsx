'use client';

import React from 'react';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';

interface ConsoleOutputProps {
  output: string;
  isVisible: boolean;
  toggleVisibility: () => void;
  title?: string;
}

const ConsoleOutput: React.FC<ConsoleOutputProps> = ({
  output,
  isVisible,
  toggleVisibility,
  title = 'Command Output'
}) => {
  return (
    <div className="border rounded-lg p-4 h-full">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold">{title}</h3>
        <button
          onClick={toggleVisibility}
          className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700"
          title={isVisible ? "Hide console" : "Show console"}
        >
          {isVisible ? <VisibilityOffIcon /> : <VisibilityIcon />}
        </button>
      </div>
      
      <div className="bg-black text-green-400 font-mono p-4 rounded-lg h-[calc(100%-3rem)] overflow-auto">
        {output ? (
          <pre className="whitespace-pre-wrap">{output}</pre>
        ) : (
          <div className="text-gray-500 italic">No output to display</div>
        )}
      </div>
    </div>
  );
};

export default ConsoleOutput;
