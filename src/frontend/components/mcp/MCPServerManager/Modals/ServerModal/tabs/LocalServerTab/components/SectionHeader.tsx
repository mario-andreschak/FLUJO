'use client';

import React from 'react';

interface SectionHeaderProps {
  title: string;
  isExpanded: boolean;
  onToggle: () => void;
  status?: 'default' | 'error' | 'success' | 'warning' | 'loading';
  rightContent?: React.ReactNode;
}

const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  isExpanded,
  onToggle,
  status = 'default',
  rightContent
}) => {
  // Determine text color based on status
  const getTextColorClass = () => {
    switch (status) {
      case 'error':
        return 'text-red-600 dark:text-red-400';
      case 'success':
        return 'text-green-600 dark:text-green-400';
      case 'warning':
        return 'text-orange-600 dark:text-orange-400';
      case 'loading':
        return 'text-blue-600 dark:text-blue-400';
      default:
        return 'text-gray-700 dark:text-gray-300';
    }
  };

  return (
    <div className="flex justify-between items-center mb-4">
      <div className="flex items-center">
        <button 
          type="button"
          onClick={onToggle}
          className="mr-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          title={isExpanded ? "Collapse section" : "Expand section"}
        >
          {isExpanded ? '▼' : '►'}
        </button>
        <h3 className={`text-lg font-semibold ${getTextColorClass()}`}>{title}</h3>
      </div>
      {rightContent && (
        <div className="flex items-center">
          {rightContent}
        </div>
      )}
    </div>
  );
};

export default SectionHeader;
