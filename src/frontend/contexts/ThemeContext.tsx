"use client"
import React, { createContext, useState, useContext, ReactNode, useEffect, useMemo } from 'react';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/contexts/ThemeContext');
import { ThemeProvider as MuiThemeProvider } from '@mui/material/styles';
import { getThemeOptions } from '@/frontend/utils/muiTheme';
import CssBaseline from '@mui/material/CssBaseline';
import { loadItem, saveItem, StorageKey } from '../../utils/storage';
import ClientOnly from '@/frontend/components/ClientOnly';

/**
 * Theme Context Props Interface
 * 
 * This interface defines the shape of the theme context value.
 * - toggleTheme: Function to toggle between light and dark mode
 * - isDarkMode: Boolean indicating if dark mode is currently active
 * 
 * Usage:
 * 1. Import the useTheme hook: import { useTheme } from '@/frontend/contexts/ThemeContext'
 * 2. Use the hook in your component: const { isDarkMode, toggleTheme } = useTheme()
 * 3. Access the current theme state with isDarkMode
 * 4. Toggle the theme with toggleTheme()
 * 
 * For custom theme-aware styling, consider using the utility functions in @/frontend/utils/theme
 */
interface ThemeContextProps {
  toggleTheme: () => void;
  isDarkMode: boolean;
}

const ThemeContext = createContext<ThemeContextProps | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Use a state to track hydration status
  const [isHydrated, setIsHydrated] = useState(false);
  // Default to light theme for consistent server-side rendering
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Only load theme preference after hydration is complete
  useEffect(() => {
    const loadTheme = async () => {
      log.debug('Loading theme preference from storage');
      const storedTheme = await loadItem<'light' | 'dark'>(StorageKey.THEME, 'light');
      log.info(`Theme loaded from storage: ${storedTheme}`);
      const newDarkMode = storedTheme === 'dark';
      setIsDarkMode(newDarkMode);
      
      // Apply dark theme class to root element
      if (newDarkMode) {
        document.documentElement.classList.add('dark-theme');
      } else {
        document.documentElement.classList.remove('dark-theme');
      }
      
      setIsHydrated(true);
    }
    void loadTheme();
  }, []);

  const toggleTheme = () => {
    setIsDarkMode(prev => {
      const newMode = !prev;
      const themeToSave = newMode ? 'dark' : 'light';
      log.info(`Toggling theme to: ${themeToSave}`);
      
      // Update root element class
      if (newMode) {
        document.documentElement.classList.add('dark-theme');
      } else {
        document.documentElement.classList.remove('dark-theme');
      }
      
      void saveItem<'light' | 'dark'>(StorageKey.THEME, themeToSave);
      return newMode;
    });
  };

  // Use the theme from our muiTheme utility
  const theme = useMemo(
    () => getThemeOptions(isDarkMode ? 'dark' : 'light'),
    [isDarkMode]
  );

  log.debug(`Rendering ThemeProvider with isDarkMode: ${isDarkMode}`);
  
  // Provide the theme context
  return (
    <ThemeContext.Provider value={{ toggleTheme, isDarkMode }}>
      <MuiThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    log.error('useTheme hook used outside of ThemeProvider');
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  log.debug('useTheme hook accessed');
  return context;
};
