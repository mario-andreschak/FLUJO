"use client";

import { useState, useEffect } from 'react';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/hooks/useKeyPress');

export function useKeyPress(targetKey: string): boolean {
  log.debug(`Initializing useKeyPress hook for key: ${targetKey}`);
  // State for keeping track of whether key is pressed
  const [keyPressed, setKeyPressed] = useState<boolean>(false);

  // If pressed key is our target key then set to true
  const downHandler = ({ key }: KeyboardEvent): void => {
    if (key === targetKey) {
      log.debug(`Key pressed: ${key}`);
      setKeyPressed(true);
    }
  };

  // If released key is our target key then set to false
  const upHandler = ({ key }: KeyboardEvent): void => {
    if (key === targetKey) {
      log.debug(`Key released: ${key}`);
      setKeyPressed(false);
    }
  };

  // Add event listeners
  useEffect(() => {
    log.debug(`Setting up event listeners for key: ${targetKey}`);
    window.addEventListener('keydown', downHandler);
    window.addEventListener('keyup', upHandler);
    
    // Remove event listeners on cleanup
    return () => {
      log.debug(`Cleaning up event listeners for key: ${targetKey}`);
      window.removeEventListener('keydown', downHandler);
      window.removeEventListener('keyup', upHandler);
    };
  }, [targetKey]); // Only re-run if targetKey changes

  return keyPressed;
}

export default useKeyPress;
