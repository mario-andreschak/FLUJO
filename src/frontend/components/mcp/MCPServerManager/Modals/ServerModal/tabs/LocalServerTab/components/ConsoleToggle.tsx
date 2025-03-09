'use client';

import React from 'react';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';

interface ConsoleToggleProps {
  isVisible: boolean;
  toggleVisibility: () => void;
}

const ConsoleToggle: React.FC<ConsoleToggleProps> = ({
  isVisible,
  toggleVisibility
}) => {
  return (
    <button
      type="button"
      onClick={toggleVisibility}
      className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center"
      title={isVisible ? "Hide console" : "Show console"}
    >
      {isVisible ? (
        <>
          <span className="mr-1 text-sm">Hide Console</span>
          <VisibilityOffIcon fontSize="small" />
        </>
      ) : (
        <>
          <span className="mr-1 text-sm">Show Console</span>
          <VisibilityIcon fontSize="small" />
        </>
      )}
    </button>
  );
};

export default ConsoleToggle;
