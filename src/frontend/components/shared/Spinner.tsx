'use client';

import React from 'react';

interface SpinnerProps {
  size?: 'small' | 'medium' | 'large';
  color?: 'primary' | 'secondary' | 'white';
  className?: string;
}

/**
 * A reusable spinner component for loading states
 */
const Spinner: React.FC<SpinnerProps> = ({ 
  size = 'medium', 
  color = 'primary',
  className = ''
}) => {
  // Determine size in pixels
  const sizeInPx = {
    small: 16,
    medium: 24,
    large: 36
  }[size];
  
  // Determine color class
  const colorClass = {
    primary: 'text-blue-500',
    secondary: 'text-gray-500',
    white: 'text-white'
  }[color];

  return (
    <div className={`inline-block ${className}`} role="status">
      <svg 
        className={`animate-spin ${colorClass}`}
        width={sizeInPx} 
        height={sizeInPx} 
        viewBox="0 0 24 24" 
        fill="none" 
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle 
          className="opacity-25" 
          cx="12" 
          cy="12" 
          r="10" 
          stroke="currentColor" 
          strokeWidth="4"
        />
        <path 
          className="opacity-75" 
          fill="currentColor" 
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      <span className="sr-only">Loading...</span>
    </div>
  );
};

export default Spinner;
