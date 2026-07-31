"use client"
import React, { createContext, useState, useContext, ReactNode, useEffect, useMemo } from 'react';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/contexts/ThemeContext');
import { ThemeProvider as MuiThemeProvider } from '@mui/material/styles';
import { getThemeOptions, VisualThemeStyle } from '@/frontend/utils/muiTheme';
import CssBaseline from '@mui/material/CssBaseline';
import { loadItem, saveItem, StorageKey } from '../../utils/storage';

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
export type ThemeMode = 'light' | 'dark';

export interface ThemePreset {
  mode: ThemeMode;
  style: VisualThemeStyle;
}

export interface ThemeContextProps {
  toggleTheme: () => void;
  isDarkMode: boolean;
  visualStyle: VisualThemeStyle;
  setVisualStyle: (style: VisualThemeStyle) => void;
  setThemePreset: (preset: ThemePreset) => void;
}

const ThemeContext = createContext<ThemeContextProps | undefined>(undefined);

function applyDocumentTheme(mode: ThemeMode, style: VisualThemeStyle) {
  const root = document.documentElement;
  root.classList.toggle('dark-theme', mode === 'dark');
  root.classList.toggle('modern-theme', style === 'modern');
  root.classList.toggle('legacy-theme', style === 'legacy');
  root.dataset.visualStyle = style;
  root.style.colorScheme = mode;
}

export const ThemeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // New installs start bright and approachable. Existing users still keep
  // whichever theme they already chose.
  const [isDarkMode, setIsDarkMode] = useState(false);
  // A separate preference makes the visual generation additive: existing
  // light/dark selections survive, while new and upgraded installs begin on
  // the redesigned UI.
  const [visualStyle, setVisualStyleState] = useState<VisualThemeStyle>('modern');

  // Only load theme preference after hydration is complete
  useEffect(() => {
    const loadTheme = async () => {
      log.debug('Loading theme preference from storage');
      const [storedTheme, storedStyle] = await Promise.all([
        loadItem<ThemeMode>(StorageKey.THEME, 'light'),
        loadItem<VisualThemeStyle>(StorageKey.THEME_STYLE, 'modern'),
      ]);
      log.info(`Theme loaded from storage: ${storedTheme}`);
      const resolvedTheme: ThemeMode = storedTheme === 'dark' ? 'dark' : 'light';
      const resolvedStyle: VisualThemeStyle = storedStyle === 'legacy' ? 'legacy' : 'modern';
      const newDarkMode = resolvedTheme === 'dark';
      setIsDarkMode(newDarkMode);
      setVisualStyleState(resolvedStyle);
      applyDocumentTheme(resolvedTheme, resolvedStyle);
    }
    void loadTheme();
  }, []);

  const toggleTheme = () => {
    setIsDarkMode(prev => {
      const newMode = !prev;
      const themeToSave: ThemeMode = newMode ? 'dark' : 'light';
      log.info(`Toggling theme to: ${themeToSave}`);
      applyDocumentTheme(themeToSave, visualStyle);
      void saveItem<ThemeMode>(StorageKey.THEME, themeToSave);
      return newMode;
    });
  };

  const setVisualStyle = (style: VisualThemeStyle) => {
    setVisualStyleState(style);
    applyDocumentTheme(isDarkMode ? 'dark' : 'light', style);
    void saveItem<VisualThemeStyle>(StorageKey.THEME_STYLE, style);
  };

  const setThemePreset = ({ mode, style }: ThemePreset) => {
    setIsDarkMode(mode === 'dark');
    setVisualStyleState(style);
    applyDocumentTheme(mode, style);
    void Promise.all([
      saveItem<ThemeMode>(StorageKey.THEME, mode),
      saveItem<VisualThemeStyle>(StorageKey.THEME_STYLE, style),
    ]);
  };

  // Use the theme from our muiTheme utility
  const theme = useMemo(
    () => getThemeOptions(isDarkMode ? 'dark' : 'light', visualStyle),
    [isDarkMode, visualStyle]
  );

  log.debug(`Rendering ThemeProvider with isDarkMode: ${isDarkMode}`);
  
  // Provide the theme context
  return (
    <ThemeContext.Provider value={{ toggleTheme, isDarkMode, visualStyle, setVisualStyle, setThemePreset }}>
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
