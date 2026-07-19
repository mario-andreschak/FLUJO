"use client";

import { useTheme } from '@/frontend/contexts/ThemeContext';
import { createLogger } from '@/utils/logger';
import { themeColors } from './paletteTokens';

const log = createLogger('frontend/utils/theme');

/**
 * Theme color constants.
 *
 * The raw palette lives in the dependency-free `paletteTokens` module (so it can
 * be imported in plain Node contexts / tests) and is re-exported here to keep
 * every existing `import { themeColors } from '@/frontend/utils/theme'` working.
 */
export { themeColors } from './paletteTokens';
export type { ThemeColors } from './paletteTokens';

/**
 * Get a CSS variable value based on the current theme
 * @param variableName The CSS variable name without the -- prefix
 * @returns The CSS variable value
 */
export function getCssVar(variableName: string): string {
  return `var(--${variableName})`;
}

/**
 * Hook to get theme-aware values
 * @returns Object with theme utility functions
 */
export function useThemeUtils() {
  const { isDarkMode } = useTheme();
  
  log.debug(`useThemeUtils called with isDarkMode: ${isDarkMode}`);
  
  /**
   * Get a value based on the current theme
   * @param lightValue Value to use in light mode
   * @param darkValue Value to use in dark mode
   * @returns The appropriate value based on the current theme
   */
  const getThemeValue = <T,>(lightValue: T, darkValue: T): T => {
    return isDarkMode ? darkValue : lightValue;
  };
  
  /**
   * Get a color from the theme colors
   * @param colorPath Path to the color in the themeColors object (e.g., 'background', 'error.text')
   * @returns The color value for the current theme
   */
  const getThemeColor = (colorPath: string): string => {
    const theme = isDarkMode ? 'dark' : 'light';
    const parts = colorPath.split('.');
    
    let value: any = themeColors[theme];
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        log.warn(`Theme color path not found: ${colorPath}`);
        return '';
      }
    }
    
    return value as string;
  };
  
  return {
    getThemeValue,
    getThemeColor,
    colors: isDarkMode ? themeColors.dark : themeColors.light,
    isDarkMode,
  };
}

/**
 * Apply theme-specific styles to an element
 * @param element The HTML element to apply styles to
 * @param isDarkMode Whether dark mode is enabled
 */
export function applyThemeStyles(element: HTMLElement, isDarkMode: boolean): void {
  if (isDarkMode) {
    element.classList.add('dark-theme');
  } else {
    element.classList.remove('dark-theme');
  }
}
