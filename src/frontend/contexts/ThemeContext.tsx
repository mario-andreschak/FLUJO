"use client"
import React, { createContext, useState, useContext, ReactNode, useEffect, useMemo } from 'react';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/contexts/ThemeContext');
import { ThemeProvider as MuiThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { loadItem, saveItem, StorageKey } from '../../utils/storage';
import ClientOnly from '@/frontend/components/ClientOnly';

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
      setIsDarkMode(storedTheme === 'dark');
      setIsHydrated(true);
    }
    void loadTheme();
  }, []);

  const toggleTheme = () => {
    setIsDarkMode(prev => {
      const newMode = !prev;
      const themeToSave = newMode ? 'dark' : 'light';
      log.info(`Toggling theme to: ${themeToSave}`);
      void saveItem<'light' | 'dark'>(StorageKey.THEME, themeToSave);
      return newMode;
    });
  };

  // Create the theme based on the current mode
  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: isDarkMode ? 'dark' : 'light',
          primary: {
            main: '#3498DB',
          },
          secondary: {
            main: '#95A5A6',
          },
          background: {
            default: isDarkMode ? '#2C3E50' : '#FFFFFF',
            paper: isDarkMode ? '#34495E' : '#F5F6FA',
          },
          text: {
            primary: isDarkMode ? '#ECF0F1' : '#2C3E50',
            secondary: isDarkMode ? '#BDC3C7' : '#7F8C8D',
          },
        },
        typography: {
          fontFamily: 'var(--font-geist-sans)',
          h1: {
            fontWeight: 600,
          },
          h2: {
            fontWeight: 600,
          },
          h3: {
            fontWeight: 600,
          },
          h4: {
            fontWeight: 500,
          },
          h5: {
            fontWeight: 500,
          },
          h6: {
            fontWeight: 500,
          },
        },
        components: {
          MuiCssBaseline: {
            styleOverrides: {
              body: {
                minHeight: '100vh',
              },
            },
          },
        },
      }),
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
