import { useEffect } from 'react';
import { useTheme } from '@mui/material';
import '../styles/index.css';

/**
 * A custom hook to handle all Swagger UI styling
 * Manages critical styles, Swagger UI CSS import, and custom styling
 * 
 * @param {boolean} isClient - Whether the code is running on client or server
 * @param {boolean} useModernUI - Whether modern UI is being used
 * @returns {void}
 */
export const useSwaggerStyles = (isClient: boolean, useModernUI: boolean): void => {
  const theme = useTheme();

  // Add critical styles to prevent FOUC (Flash Of Unstyled Content)
  useEffect(() => {
    if (isClient) {
      const criticalStyles = document.createElement("style");
      criticalStyles.id = "swagger-critical-styles";
      criticalStyles.innerHTML = `
        /* Prevent vertical path display during loading */
        .swagger-ui .opblock-summary-path,
        .swagger-ui .opblock-summary-path a {
          display: inline-block !important;
          white-space: nowrap !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
          max-width: 800px !important;
          word-break: normal !important;
          word-wrap: normal !important;
          vertical-align: middle !important;
        }
        
        /* Hide paths until properly rendered */
        .swagger-ui .opblock-summary-path:empty {
          opacity: 0;
        }
        
        /* Fix focus outlines */
        .swagger-ui .opblock:focus,
        .swagger-ui .opblock:focus-within,
        .swagger-ui .opblock-summary:focus,
        .swagger-ui .opblock-summary:focus-within,
        .swagger-ui .opblock-summary-control:focus {
          outline: none !important;
          box-shadow: none !important;
        }
        
        /* Fix animation during opening */
        .swagger-ui .opblock-body {
          will-change: height;
        }
      `;
      
      // Insert at the beginning of head for highest priority
      document.head.insertBefore(criticalStyles, document.head.firstChild);
      
      return () => {
        const styleEl = document.getElementById("swagger-critical-styles");
        if (styleEl) document.head.removeChild(styleEl);
      };
    }
  }, [isClient]);

  // Add Swagger UI CSS import when using standard UI
  useEffect(() => {
    if (!useModernUI && isClient) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui.css';
      link.id = 'swagger-ui-styles';
      document.head.appendChild(link);

      return () => {
        const linkElement = document.getElementById('swagger-ui-styles');
        if (linkElement) {
          document.head.removeChild(linkElement);
        }
      };
    }
  }, [useModernUI, isClient]);

  // Add a specific class to the root when using SwaggerUI
  useEffect(() => {
    if (!useModernUI && isClient) {
      document.documentElement.classList.add("swagger-ui-active");

      // Add theme-specific class to help with styling
      if (theme.palette.mode === "dark") {
        document.documentElement.classList.add("swagger-dark-theme");
      } else {
        document.documentElement.classList.remove("swagger-dark-theme");
      }

      return () => {
        document.documentElement.classList.remove("swagger-ui-active");
        document.documentElement.classList.remove("swagger-dark-theme");
      };
    }
  }, [useModernUI, theme.palette.mode, isClient]);

  // Fix for endpoint paths displayed vertically
  useEffect(() => {
    if (isClient && !useModernUI) {
      // Fix all endpoint paths that might display vertically
      const fixPathDisplay = () => {
        setTimeout(() => {
          const pathElements = document.querySelectorAll('.swagger-ui .opblock-summary-path');
          pathElements.forEach(pathEl => {
            if (pathEl instanceof HTMLElement) {
              // Force proper display with inline styles to make routes look like code blocks
              const isDark = theme.palette.mode === 'dark';
              const styles = {
                display: 'inline-block !important',
                whiteSpace: 'nowrap !important',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '600px',
                padding: '6px 12px',
                backgroundColor: isDark ? 'rgba(30, 30, 30, 0.6)' : 'rgba(240, 240, 240, 0.8)',
                border: `1px solid ${isDark ? 'rgba(80, 80, 80, 0.5)' : 'rgba(220, 220, 220, 0.8)'}`,
                borderRadius: '4px',
                fontFamily: 'monospace',
                fontSize: '13px',
                letterSpacing: '0.3px',
                boxShadow: isDark ? 'inset 0 1px 3px rgba(0,0,0,0.2)' : 'inset 0 1px 3px rgba(0,0,0,0.05)',
                color: isDark ? '#e0e0e0' : '#333'
              };
              
              // Apply all styles directly to the element
              Object.assign(pathEl.style, styles);
            }
          });
        }, 300);
      };
      
      // Fix on initial load
      fixPathDisplay();
      
      // Run it again after a delay to catch any dynamically added elements
      setTimeout(fixPathDisplay, 1000);
      
      // Create an observer to fix paths when new ones appear
      const observer = new MutationObserver(() => {
        fixPathDisplay();
      });
      
      // Start observing the document with the configured parameters
      observer.observe(document.body, { childList: true, subtree: true });
      
      return () => {
        observer.disconnect();
      };
    }
  }, [isClient, useModernUI, theme.palette.mode]);
};

export default useSwaggerStyles; 