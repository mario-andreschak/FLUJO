import React, { useEffect, useRef } from "react";
import SwaggerUI from "swagger-ui-react";
import { useTheme } from "@mui/material";

// Function to suppress React strict mode warnings for specific component patterns
function suppressStrictModeWarnings() {
  // Store the original console.error
  const originalConsoleError = console.error;

  // Replace console.error with a filtered version
  console.error = (...args) => {
    // Filter out the specific warning about UNSAFE_componentWillReceiveProps
    const suppressedWarnings = [
      "Using UNSAFE_componentWillReceiveProps in strict mode is not recommended",
      "Please update the following components: OperationContainer",
    ];

    // Check if this is a warning we want to suppress
    const shouldSuppress = suppressedWarnings.some(
      (warningText) =>
        args.length > 0 &&
        typeof args[0] === "string" &&
        args[0].includes(warningText)
    );

    if (!shouldSuppress) {
      originalConsoleError(...args);
    }
  };

  // Return a cleanup function to restore the original console.error
  return () => {
    console.error = originalConsoleError;
  };
}

// Function to apply custom theme to Swagger UI
function applyCustomStyles(isDark: boolean, theme: any) {
  // Create a style element for our custom styles
  const styleEl = document.createElement("style");
  styleEl.id = "swagger-custom-theme";

  // Get the font family from the theme
  const fontFamily = theme.typography.fontFamily;
  const primaryColor = theme.palette.primary.main;
  const textColor = theme.palette.text.primary;
  const secondaryTextColor = theme.palette.text.secondary;
  const backgroundColor = theme.palette.background.paper;
  const backgroundColorDarker = isDark 
    ? 'rgba(33, 33, 33, 0.9)'  // Darker background for dark mode
    : 'rgba(245, 245, 245, 0.9)'; // Light grey for light mode
  const borderColor = theme.palette.divider;

  // Define custom styles based on the current theme
  const customStyles = `
    /* Override swagger default dark theme with our custom one */
    body .swagger-ui {
      background: transparent;
    }
    
    .swagger-ui .wrapper {
      padding: 0;
    }
    
    /* Global Swagger UI theme customizations */
    .swagger-ui {
      font-family: ${fontFamily};
      color: ${textColor};
      line-height: 1.5;
    }
    
    /* Ensure containers are transparent */
    .swagger-ui .wrapper, 
    .swagger-ui .scheme-container,
    .swagger-ui .information-container {
      background-color: transparent;
    }
    
    /* Better typography and spacing */
    .swagger-ui .opblock-tag {
      font-family: ${fontFamily};
      font-size: 1.2rem;
      padding: 16px 20px;
      margin: 0 0 8px;
      position: sticky;
      top: 0;
      z-index: 2;
      background: ${isDark ? 'rgba(39, 43, 51, 0.98)' : 'rgba(245, 245, 245, 0.98)'};
      border-width: 1px 1px 0 1px;
      border-style: solid;
      border-color: ${borderColor};
      border-radius: 8px 8px 0 0;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      transition: all 0.2s ease;
      ${isDark ? 'color: rgba(255, 255, 255, 0.95); text-shadow: 0 1px 2px rgba(0,0,0,0.2);' : ''}
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    
    .swagger-ui .opblock-tag:hover {
      background: ${isDark ? 'rgba(45, 49, 57, 0.98)' : 'rgba(240, 240, 240, 0.98)'};
      transform: translateY(-1px);
      box-shadow: 0 3px 8px rgba(0,0,0,0.15);
    }
    
    /* Style the arrow differently to look less like an accordion */
    .swagger-ui .opblock-tag svg {
      transition: all 0.3s ease;
      opacity: 0.6;
      width: 20px;
      height: 20px;
      margin-left: 8px;
    }
    
    .swagger-ui .opblock-tag:hover svg {
      opacity: 0.9;
    }
    
    .swagger-ui .opblock-tag-section {
      margin-bottom: 32px;
      position: relative;
    }
    
    /* Add a background behind the operations to visually group them */
    .swagger-ui .opblock-tag-section > .no-margin {
      background: ${isDark ? 'rgba(33, 33, 33, 0.3)' : 'rgba(250, 250, 250, 0.6)'};
      border: 1px solid ${borderColor};
      border-radius: 0 0 8px 8px;
      margin-top: -2px !important;
      padding: 15px;
      padding-top: 20px;
      box-shadow: 0 3px 5px rgba(0,0,0,0.08);
    }
    
    /* Make operation blocks stand out from their container */
    .swagger-ui .opblock {
      background-color: ${isDark ? 'rgba(39, 43, 51, 0.95)' : backgroundColorDarker};
      border-radius: 8px;
      margin-bottom: 12px;
      box-shadow: 0 2px 6px rgba(0,0,0,${isDark ? '0.2' : '0.1'});
      border: 1px solid ${isDark ? 'rgba(80, 80, 80, 0.5)' : borderColor};
      overflow: hidden;
      transition: all 0.2s ease;
    }
    
    .swagger-ui .opblock:last-child {
      margin-bottom: 0;
    }
    
    /* Better method colors */
    .swagger-ui .opblock-get .opblock-summary-method {
      background-color: ${isDark ? '#1976d2' : '#2196f3'};
      font-weight: 600;
      letter-spacing: 0.5px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    }
    
    .swagger-ui .opblock-post .opblock-summary-method {
      background-color: ${isDark ? '#2e7d32' : '#4caf50'};
      font-weight: 600;
      letter-spacing: 0.5px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    }
    
    .swagger-ui .opblock-put .opblock-summary-method {
      background-color: ${isDark ? '#ed6c02' : '#ff9800'};
      font-weight: 600;
      letter-spacing: 0.5px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    }
    
    .swagger-ui .opblock-delete .opblock-summary-method {
      background-color: ${isDark ? '#c62828' : '#f44336'};
      font-weight: 600;
      letter-spacing: 0.5px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    }
    
    .swagger-ui .opblock-summary-method {
      font-weight: 600;
      min-width: 80px;
      text-align: center;
      border-radius: 4px;
      padding: 8px 0;
      color: white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.15);
      display: inline-block;
      margin: 0 10px 0 0;
    }
    
    .swagger-ui .opblock:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,${isDark ? '0.3' : '0.15'});
      transform: translateY(-1px);
    }
    
    .swagger-ui .opblock .opblock-summary {
      padding: 12px 20px;
      border-bottom: 1px solid ${borderColor};
      cursor: pointer;
      transition: background-color 0.2s ease;
    }
    
    .swagger-ui .opblock .opblock-summary:hover {
      background-color: ${isDark ? 'rgba(50, 55, 65, 0.5)' : 'rgba(240, 240, 240, 0.8)'};
    }
    
    .swagger-ui .opblock .opblock-summary-description {
      font-family: ${fontFamily};
      font-weight: 400;
      padding: 0 12px;
      color: ${secondaryTextColor};
    }
    
    /* Make routes stand out like markdown code */
    .swagger-ui .opblock .opblock-summary-path {
      padding: 6px 12px;
      font-family: ${theme.typography.fontFamily.replace(/"/g, "")}, monospace;
      font-weight: 500;
      color: ${isDark ? '#e0e0e0' : '#333'};
      display: inline-block;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      background-color: ${isDark ? 'rgba(30, 30, 30, 0.6)' : 'rgba(240, 240, 240, 0.8)'};
      border: 1px solid ${isDark ? 'rgba(80, 80, 80, 0.5)' : 'rgba(220, 220, 220, 0.8)'};
      border-radius: 4px;
      font-size: 13px;
      letter-spacing: 0.3px;
      box-shadow: ${isDark ? 'inset 0 1px 3px rgba(0,0,0,0.2)' : 'inset 0 1px 3px rgba(0,0,0,0.05)'};
    }
    
    /* Parameter section styling */
    .swagger-ui .opblock-description-wrapper, 
    .swagger-ui .opblock-external-docs-wrapper, 
    .swagger-ui .opblock-title_normal {
      padding: 15px 20px;
      margin: 0;
    }
    
    .swagger-ui .opblock-description-wrapper p, 
    .swagger-ui .opblock-external-docs-wrapper p, 
    .swagger-ui .opblock-title_normal p {
      font-family: ${fontFamily};
      color: ${secondaryTextColor};
    }
    
    .swagger-ui .parameters-container {
      padding: 0 20px;
      margin: 0 0 20px;
    }
    
    .swagger-ui .parameter__name {
      font-family: ${fontFamily};
      font-weight: 500;
      font-size: 0.9rem;
      padding-right: 12px;
      color: ${textColor};
    }
    
    .swagger-ui .parameter__in {
      font-family: ${fontFamily};
      font-size: 0.75rem;
      color: ${secondaryTextColor};
      padding-left: 8px;
    }
    
    .swagger-ui .parameter__type {
      font-family: ${fontFamily};
      color: ${textColor};
    }
    
    /* Response section styling */
    .swagger-ui .responses-wrapper {
      padding: 0 20px;
    }
    
    .swagger-ui .response-col_status {
      font-size: 0.9rem;
      font-weight: 600;
      color: ${textColor};
    }
    
    .swagger-ui h4, .swagger-ui h5 {
      font-family: ${fontFamily};
      margin: 16px 0 8px;
      color: ${textColor};
    }
    
    /* Form controls styling */
    .swagger-ui select {
      font-family: ${fontFamily};
      padding: 8px 12px;
      border-radius: 4px;
      border: 1px solid ${borderColor};
      background-color: ${backgroundColor};
      color: ${textColor};
      width: 100%;
      height: auto;
    }
    
    /* Execute button styling */
    .swagger-ui .btn {
      font-family: ${fontFamily};
      transition: all 0.2s ease;
      padding: 8px 12px;
      border-radius: 4px;
      font-weight: 500;
    }
    
    /* Try Out Button */
    .swagger-ui .try-out__btn {
      background-color: ${primaryColor};
      color: white;
      border: none;
      padding: 5px 12px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 12px;
      transition: all 0.2s ease;
      margin-bottom: 10px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    
    .swagger-ui .try-out__btn:hover {
      background-color: ${theme.palette.primary.dark};
      transform: translateY(-1px);
      box-shadow: 0 3px 6px rgba(0,0,0,0.3);
    }
    
    /* Execute button */
    .swagger-ui .btn.execute {
      background-color: ${theme.palette.success.main};
      color: white;
      border: none;
      padding: 6px 20px;
      font-weight: 600;
      font-size: 13px;
      border-radius: 4px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      transition: all 0.2s ease;
      min-width: 100px;
      max-width: 140px;
      text-align: center;
      display: inline-block;
      margin: 0 5px;
    }
    
    .swagger-ui .btn.execute:hover {
      background-color: ${theme.palette.success.dark};
      box-shadow: 0 2px 5px rgba(0,0,0,0.3);
      transform: translateY(-1px);
    }
    
    /* Cancel button */
    .swagger-ui .btn.cancel {
      background-color: ${theme.palette.error.main};
      color: white;
      border: none;
      font-weight: 600;
      font-size: 12px;
      padding: 5px 15px;
      border-radius: 4px;
      transition: all 0.2s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      min-width: 80px;
      text-align: center;
      margin: 0 5px;
    }
    
    .swagger-ui .btn.cancel:hover {
      background-color: ${theme.palette.error.dark};
      transform: translateY(-1px);
      box-shadow: 0 2px 5px rgba(0,0,0,0.3);
    }
    
    /* Fix the execute-wrapper to be less wide */
    .swagger-ui .execute-wrapper {
      padding: 15px 0;
      text-align: center;
      width: auto !important;
      max-width: none !important;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    /* Response example values */
    .swagger-ui .example-value {
      background-color: ${isDark ? '#1e1e1e' : '#f5f5f5'};
      color: ${isDark ? '#e0e0e0' : '#333'};
      padding: 10px;
      font-family: ${theme.typography.fontFamily.replace(/"/g, "")}, monospace;
      font-size: 13px;
      border-radius: 0 0 4px 4px;
    }
    
    /* Dark mode text improvements */
    ${isDark ? `
      .swagger-ui .markdown p, 
      .swagger-ui .markdown pre,
      .swagger-ui .renderedMarkdown p, 
      .swagger-ui .renderedMarkdown pre,
      .swagger-ui .opblock-description-wrapper p,
      .swagger-ui .opblock-external-docs-wrapper p,
      .swagger-ui .opblock-title_normal p {
        color: rgba(255, 255, 255, 0.87);
      }
      
      /* Dark mode parameter descriptions */
      .swagger-ui .parameter__name {
        color: rgba(255, 255, 255, 0.9);
        font-weight: 500;
      }
      
      .swagger-ui .parameter__in {
        color: rgba(255, 255, 255, 0.7);
      }
      
      /* Schema property names */
      .swagger-ui .model-title {
        color: #90caf9;
      }
      
      .swagger-ui table tbody tr td {
        color: rgba(255, 255, 255, 0.87);
      }
      
      /* Response descriptions */
      .swagger-ui .response-col_description__inner p {
        color: rgba(255, 255, 255, 0.87);
      }
      
      /* Code blocks */
      .swagger-ui .microlight {
        background-color: #1a1a1a;
        border-color: #333;
      }
    ` : ''}
    
    /* Improve parameter containers */
    .swagger-ui .parameters-container {
      margin: 0 0 20px;
      border: 1px solid ${isDark ? 'rgba(80, 80, 80, 0.5)' : borderColor};
      border-radius: 6px;
      background-color: ${isDark ? 'rgba(32, 36, 44, 0.9)' : backgroundColor};
      overflow: hidden;
    }
    
    /* Customize method colors - improve contrast */
    .swagger-ui .opblock-get .opblock-summary-method {
      background-color: ${isDark ? '#1976d2' : '#2196f3'};
    }
    
    .swagger-ui .opblock-post .opblock-summary-method {
      background-color: ${isDark ? '#2e7d32' : '#4caf50'};
    }
    
    .swagger-ui .opblock-put .opblock-summary-method {
      background-color: ${isDark ? '#ed6c02' : '#ff9800'};
    }
    
    .swagger-ui .opblock-delete .opblock-summary-method {
      background-color: ${isDark ? '#c62828' : '#f44336'};
    }
    
    /* Fix white outline on active/focused elements */
    .swagger-ui .opblock:focus,
    .swagger-ui .opblock:focus-within,
    .swagger-ui .opblock-summary:focus,
    .swagger-ui .opblock-summary:focus-within,
    .swagger-ui .opblock-summary-control:focus {
      outline: none !important;
      box-shadow: none !important;
    }
    
    /* Add a more subtle indicator for focus state */
    .swagger-ui .opblock.is-open {
      box-shadow: 0 0 0 1px ${isDark ? 'rgba(79, 195, 247, 0.3)' : 'rgba(33, 150, 243, 0.3)'}, 0 3px 10px rgba(0,0,0,0.2) !important;
      border-color: ${isDark ? 'rgba(79, 195, 247, 0.5)' : 'rgba(33, 150, 243, 0.5)'} !important;
    }
    
    /* Fix the operation container's white outline */
    .swagger-ui .opblock .opblock-section-header,
    .swagger-ui .opblock .tab-header,
    .swagger-ui .opblock .try-out.btn-group,
    .swagger-ui .opblock .execute-wrapper {
      outline: none !important;
    }
    
    /* Fix transition when opening operations */
    .swagger-ui .opblock .opblock-summary {
      cursor: pointer;
      transition: background-color 0.2s ease;
    }
    
    .swagger-ui .opblock .opblock-summary:hover {
      background-color: ${isDark ? 'rgba(50, 55, 65, 0.5)' : 'rgba(240, 240, 240, 0.8)'};
    }
    
    .swagger-ui .opblock-body {
      transition: all 0.3s ease-in-out !important;
    }
    
    .swagger-ui .opblock.is-open {
      transition: all 0.3s ease;
    }
    
    /* Fix loading appearance */
    .swagger-ui .loading-container {
      padding: 12px 0;
      background-color: transparent;
      opacity: 0.7;
    }
    
    .swagger-ui .loading-container .loading {
      background-color: transparent;
    }
    
    /* Improve expand/collapse indicators */
    .swagger-ui .expand-methods svg,
    .swagger-ui .expand-operation svg {
      transition: transform 0.3s ease;
    }
  `;

  styleEl.textContent = customStyles;

  // Remove any existing custom styles
  const existingStyle = document.getElementById("swagger-custom-theme");
  if (existingStyle) {
    existingStyle.remove();
  }

  // Add the style to the document head
  document.head.appendChild(styleEl);

  // Return a cleanup function to remove the style element
  return () => {
    if (styleEl && styleEl.parentNode) {
      styleEl.parentNode.removeChild(styleEl);
    }
  };
}

// Add the SwaggerUIProps interface to match what the page component expects
interface SwaggerUIProps {
  url: string;
  docExpansion?: "list" | "full" | "none";
  deepLinking?: boolean;
  tryItOutEnabled?: boolean;
  defaultModelsExpandDepth?: number;
  displayOperationId?: boolean;
  filter?: boolean;
  showExtensions?: boolean;
  requestInterceptor?: (req: any) => any;
  responseInterceptor?: (res: any) => any;
}

// Create the component function that will be the default export
export default function SwaggerUIWrapper(props: SwaggerUIProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const swaggerRef = useRef<any>(null);

  // Suppress warnings on mount
  useEffect(() => {
    const cleanup = suppressStrictModeWarnings();
    return cleanup;
  }, []);

  // Apply custom styles when theme changes
  useEffect(() => {
    const cleanup = applyCustomStyles(isDark, theme);
    return cleanup;
  }, [isDark, theme]);

  // Pass props to the Swagger UI component
  return <SwaggerUI {...props} />;
}