'use client';

import { useState } from 'react';
import { useI18n } from '@/frontend/contexts/I18nContext';

export const useConsoleOutput = () => {
  const { t } = useI18n();
  const [consoleOutput, setConsoleOutput] = useState<string>('');
  const [isConsoleVisible, setIsConsoleVisible] = useState<boolean>(false);
  const [consoleTitle, setConsoleTitle] = useState<string>(() => t('mcp.local.console.output'));

  const toggleConsoleVisibility = () => {
    setIsConsoleVisible(prev => !prev);
  };

  const appendToConsole = (text: string) => {
    setConsoleOutput(prev => prev + text);
  };

  const clearConsole = () => {
    setConsoleOutput('');
  };

  const updateConsole = (text: string | ((prev: string) => string)) => {
    setConsoleOutput(text);
  };

  return {
    consoleOutput,
    isConsoleVisible,
    consoleTitle,
    setConsoleTitle,
    toggleConsoleVisibility,
    setIsConsoleVisible,
    appendToConsole,
    clearConsole,
    updateConsole
  };
};
