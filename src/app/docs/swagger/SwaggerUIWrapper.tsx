import React, { useEffect } from "react";
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
  const borderColor = theme.palette.divider;

  // Define custom styles based on the current theme
  const customStyles = `
    /* Global Swagger UI theme customizations */
    .swagger-ui {
      font-family: ${fontFamily};
      color: ${textColor};
      line-height: 1.5;
    }
    
    /* Better typography and spacing */
    .swagger-ui .opblock-tag {
      font-family: ${fontFamily};
      font-size: 1.2rem;
      padding: 16px 20px;
      margin: 0 0 12px;
    }
    
    .swagger-ui .opblock .opblock-summary {
      padding: 12px 20px;
    }
    
    .swagger-ui .opblock .opblock-summary-method {
      font-weight: 600;
      min-width: 80px;
      text-align: center;
      border-radius: 4px;
      padding: 8px 0;
    }
    
    .swagger-ui .opblock .opblock-summary-description {
      font-family: ${fontFamily};
      font-weight: 400;
      padding: 0 12px;
      color: ${secondaryTextColor};
    }
    
    .swagger-ui .opblock .opblock-summary-path {
      padding: 0 10px;
      font-family: ${theme.typography.fontFamily.replace(/"/g, "")}, monospace;
      font-weight: 500;
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
    }
    
    .swagger-ui .parameter__in {
      font-family: ${fontFamily};
      font-size: 0.75rem;
      color: ${secondaryTextColor};
      padding-left: 8px;
    }
    
    .swagger-ui .parameter__type {
      font-family: ${fontFamily};
    }
    
    /* Response section styling */
    .swagger-ui .responses-wrapper {
      padding: 0 20px;
    }
    
    .swagger-ui .response-col_status {
      font-size: 0.9rem;
      font-weight: 600;
    }
    
    .swagger-ui h4, .swagger-ui h5 {
      font-family: ${fontFamily};
      margin: 16px 0 8px;
    }
    
    .swagger-ui select {
      font-family: ${fontFamily};
      padding: 6px 8px;
      border-radius: 4px;
    }
    
    /* Execute button styling */
    .swagger-ui .btn {
      font-family: ${fontFamily};
      transition: all 0.2s ease;
      padding: 8px 12px;
      border-radius: 4px;
    }
    
    .swagger-ui .btn.execute {
      background-color: ${primaryColor};
      color: white;
      border-color: ${primaryColor};
    }
    
    /* Schema styling */
    .swagger-ui .model-box {
      padding: 16px;
      border-radius: 4px;
    }
    
    .swagger-ui .model {
      font-family: ${fontFamily};
    }
    
    .swagger-ui .model-title {
      font-family: ${fontFamily};
      font-weight: 600;
    }
    
    /* Code styling */
    .swagger-ui .highlight-code {
      font-family: ${theme.typography.fontFamily.replace(/"/g, "")}, monospace;
      padding: 16px;
      border-radius: 4px;
    }
    
    /* Section headers */
    .swagger-ui .opblock .opblock-section-header {
      padding: 12px 20px;
      background-color: ${
        isDark ? "rgba(60, 60, 60, 0.4)" : "rgba(240, 240, 240, 0.4)"
      };
    }
    
    .swagger-ui .opblock .opblock-section-header h4 {
      font-family: ${fontFamily};
      font-weight: 500;
      margin: 0;
    }
    
    /* Try it out section */
    .swagger-ui .try-out__btn {
      background-color: transparent;
      border: 1px solid ${borderColor};
      color: ${textColor};
      padding: 6px 12px;
      border-radius: 4px;
    }
    
    /* Table styling */
    .swagger-ui .table-container {
      padding: 0 20px 20px;
    }
    
    .swagger-ui table {
      border-collapse: separate;
      border-spacing: 0;
      width: 100%;
      margin: 0 0 20px;
    }
    
    .swagger-ui table thead tr th {
      font-family: ${fontFamily};
      font-weight: 500;
      padding: 10px 12px;
      text-align: left;
      border-bottom: 2px solid ${borderColor};
    }
    
    .swagger-ui table tbody tr td {
      padding: 10px 12px;
      border-bottom: 1px solid ${borderColor};
      vertical-align: top;
    }
    
    /* JSON Schema form */
    .swagger-ui .json-schema-form-item input {
      padding: 8px 12px;
      border-radius: 4px;
      border: 1px solid ${borderColor};
      width: 100%;
      font-family: ${fontFamily};
    }
    
    /* Better JSON display */
    .swagger-ui .microlight {
      font-family: ${theme.typography.fontFamily.replace(/"/g, "")}, monospace;
      line-height: 1.4;
      padding: 0;
    }
    
    /* Dark mode specific adjustments */
    ${
      isDark
        ? `
      .swagger-ui .opblock .opblock-summary-description {
        color: rgba(255, 255, 255, 0.7);
      }
      
      .swagger-ui .markdown p, .swagger-ui .markdown pre, 
      .swagger-ui .renderedMarkdown p, .swagger-ui .renderedMarkdown pre {
        color: rgba(255, 255, 255, 0.8);
      }
      
      .swagger-ui .model-box {
        background: rgba(30, 30, 30, 0.4);
      }
      
      .swagger-ui .parameter__name, 
      .swagger-ui .parameter__type, 
      .swagger-ui .parameter__deprecated, 
      .swagger-ui .parameter__in {
        color: rgba(255, 255, 255, 0.8);
      }
      
      .swagger-ui input, .swagger-ui select {
        background-color: rgba(59, 59, 59, 0.5);
        color: white;
      }
      
      .swagger-ui textarea {
        background-color: rgba(59, 59, 59, 0.5);
        color: white;
      }
      
      .swagger-ui .tab li {
        color: rgba(255, 255, 255, 0.7);
      }
      
      .swagger-ui section.models {
        background: rgba(50, 50, 50, 0.4);
        border: 1px solid rgba(255, 255, 255, 0.1);
      }
    `
        : ""
    }
    
    /* Method-specific adjustments */
    .swagger-ui .opblock-get .opblock-summary-method {
      background-color: var(--get-method-color, #61affe);
    }
    
    .swagger-ui .opblock-post .opblock-summary-method {
      background-color: var(--post-method-color, #49cc90);
    }
    
    .swagger-ui .opblock-put .opblock-summary-method {
      background-color: var(--put-method-color, #fca130);
    }
    
    .swagger-ui .opblock-delete .opblock-summary-method {
      background-color: var(--delete-method-color, #f93e3e);
    }
    
    /* Fix for JSON fields in request bodies */
    .swagger-ui textarea {
      min-height: 150px;
      font-family: ${theme.typography.fontFamily.replace(/"/g, "")}, monospace;
      padding: 12px;
      border-radius: 4px;
      width: 100%;
    }
    
    /* Improved parameter styling */
    .swagger-ui .parameter__name.required {
      position: relative;
      font-weight: 600;
    }
    
    .swagger-ui .parameter__name.required:after {
      content: "*";
      color: #ff4d4f;
      margin-left: 5px;
      font-size: 16px;
      font-weight: bold;
    }
    
    /* Improve parameter containers */
    .swagger-ui .parameters-container {
      margin: 0 0 20px;
      border: 1px solid ${borderColor};
      border-radius: 6px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.1);
    }
    
    /* Add more depth to the operations */
    .swagger-ui .opblock {
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      margin: 0 0 20px;
    }
    
    /* Fix the rounded corners */
    .swagger-ui .opblock .opblock-summary {
      border-radius: 0 !important;
    }
    
    /* Improve the method badges */
    .swagger-ui .opblock .opblock-summary-method {
      border-radius: 4px;
      font-weight: bold;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      min-width: 80px;
      text-align: center;
    }
    
    /* Style execute button */
    .swagger-ui .btn.execute {
      padding: 10px 40px;
      font-weight: 600;
      border-radius: 4px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      border: none;
      transition: all 0.2s ease;
    }
    
    .swagger-ui .btn.execute:hover {
      box-shadow: 0 3px 6px rgba(0,0,0,0.3);
      transform: translateY(-1px);
    }
    
    .swagger-ui .btn.execute:active {
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      transform: translateY(1px);
    }
    
    /* Fix padding for parameter names */
    .swagger-ui .parameter__name {
      padding-left: 15px !important;
    }
    
    /* Make 'required' more visible */
    .swagger-ui .parameter__name.required:before {
      content: "*";
      color: #ff4d4f;
      position: absolute;
      left: 0;
      top: 0;
      font-size: 18px;
      font-weight: bold;
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

interface SwaggerUIWrapperProps {
  url: string;
  docExpansion?: "list" | "full" | "none";
  deepLinking?: boolean;
  displayOperationId?: boolean;
  defaultModelsExpandDepth?: number;
  filter?: boolean | string;
  showExtensions?: boolean;
  tryItOutEnabled?: boolean;
}

export default function SwaggerUIWrapper({
  url,
  docExpansion = "list",
  deepLinking = true,
  displayOperationId = false,
  defaultModelsExpandDepth = 1,
  filter = true,
  showExtensions = false,
  tryItOutEnabled = true,
}: SwaggerUIWrapperProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  // Suppress strict mode warnings on mount
  useEffect(() => {
    const cleanupWarnings = suppressStrictModeWarnings();
    const cleanupStyles = applyCustomStyles(isDark, theme);

    return () => {
      cleanupWarnings();
      cleanupStyles();
    };
  }, [isDark, theme]);

  return (
    <SwaggerUI
      url={url}
      docExpansion={docExpansion}
      deepLinking={deepLinking}
      displayOperationId={displayOperationId}
      defaultModelsExpandDepth={defaultModelsExpandDepth}
      filter={filter}
      showExtensions={showExtensions}
      tryItOutEnabled={tryItOutEnabled}
    />
  );
}
