import { useEffect } from 'react';
import { useTheme } from '@mui/material';

/**
 * A custom hook to handle Swagger UI theme integration
 * Sets up CSS variables for theme integration
 * 
 * @param {boolean} isClient - Whether the code is running on client or server
 * @returns {void}
 */
export const useSwaggerTheme = (isClient: boolean): void => {
  const theme = useTheme();

  // Generate CSS variables for theme integration
  useEffect(() => {
    if (isClient) {
      const root = document.documentElement;

      // Primary colors
      root.style.setProperty("--primary-color", theme.palette.primary.main);
      root.style.setProperty("--primary-light", theme.palette.primary.light);
      root.style.setProperty("--primary-dark", theme.palette.primary.dark);

      // Text colors
      root.style.setProperty("--text-primary", theme.palette.text.primary);
      root.style.setProperty("--text-secondary", theme.palette.text.secondary);

      // Background colors
      root.style.setProperty("--bg-paper", theme.palette.background.paper);
      root.style.setProperty("--bg-default", theme.palette.background.default);

      // Method colors
      root.style.setProperty("--get-method-color", theme.palette.success.main);
      root.style.setProperty("--post-method-color", theme.palette.primary.main);
      root.style.setProperty("--put-method-color", theme.palette.warning.main);
      root.style.setProperty("--delete-method-color", theme.palette.error.main);

      // Border and divider
      root.style.setProperty("--divider-color", theme.palette.divider);
    }
  }, [isClient, theme]);
};

export default useSwaggerTheme; 