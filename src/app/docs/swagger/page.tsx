"use client";

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  Box,
  Container,
  Typography,
  CssBaseline,
  Paper,
  Divider,
  useTheme,
  Chip,
  Stack,
  FormControlLabel,
  Switch,
  alpha,
} from "@mui/material";
import ApiIcon from "@mui/icons-material/Api";

// Dynamically import components with no SSR
const SwaggerUI = dynamic(() => import("./SwaggerUIWrapper"), {
  ssr: false,
  loading: () => (
    <Box sx={{ p: 4, textAlign: "center" }}>
      <Typography variant="h5">Loading API Documentation...</Typography>
    </Box>
  ),
});

// This is a modern alternative UI that will be available as an option
const ModernSwaggerUI = dynamic(() => import("./ModernSwaggerUI"), {
  ssr: false,
  loading: () => (
    <Box sx={{ p: 4, textAlign: "center" }}>
      <Typography variant="h5">Loading API Documentation...</Typography>
    </Box>
  ),
});

// This flag determines if we should show the modern UI
// Setting to false by default as the modern UI is still in development
const ENABLE_MODERN_UI_TOGGLE = false;

// Additional styles for the parameters, focusing on the required indicator
const additionalStyles = `
  /* Improved Required Parameter Styling */
  .swagger-ui .parameter__name.required {
    position: relative;
    padding-left: 15px !important; 
  }
  
  .swagger-ui .parameter__name.required:before {
    content: "*";
    color: #ff4d4f;
    position: absolute;
    left: 0;
    top: 0;
    font-size: 18px;
    font-weight: bold;
  }
  
  /* Improve parameter row visual hierarchy */
  .swagger-ui .parameters-col_description {
    padding-top: 10px !important;
    padding-bottom: 10px !important;
  }
  
  /* Fix corners where blue outline appears */
  .swagger-ui .opblock {
    overflow: hidden;
    border-radius: 8px !important;
  }
  
  /* Fix the curved edges causing visual issues */
  .swagger-ui .opblock .opblock-summary {
    border-radius: 0 !important;
  }
  
  /* Add proper spacing to parameters */
  .swagger-ui tr.parameters {
    border-spacing: 0 8px !important;
  }
  
  /* Fix buttons in Authorization popup */
  .swagger-ui .dialog-ux .modal-ux-content .btn {
    margin: 0 10px 10px 0 !important;
  }
`;

export default function SwaggerDocs() {
  const [isClient, setIsClient] = useState(false);
  const [version, setVersion] = useState("1.0.0");
  const [useModernUI, setUseModernUI] = useState(false);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  useEffect(() => {
    setIsClient(true);

    // Get version from package.json if available
    fetch("/api/version")
      .then((res) => res.json())
      .then((data) => {
        if (data.version) {
          setVersion(data.version);
        }
      })
      .catch(() => {
        // Fallback to default version if API call fails
      });

    // Import CSS only on client side when using the traditional SwaggerUI
    if (!useModernUI) {
      require("swagger-ui-react/swagger-ui.css");
    }
  }, [useModernUI]);

  // For suppressing React strict mode warnings
  useEffect(() => {
    if (!useModernUI) {
      // Add a specific class to the root when using SwaggerUI to help with styling
      document.documentElement.classList.add("swagger-ui-active");

      // Add theme-specific class to help with styling
      if (isDark) {
        document.documentElement.classList.add("swagger-dark-theme");
      } else {
        document.documentElement.classList.remove("swagger-dark-theme");
      }

      return () => {
        document.documentElement.classList.remove("swagger-ui-active");
        document.documentElement.classList.remove("swagger-dark-theme");
      };
    }
  }, [useModernUI, isDark]);

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
  }, [isClient, theme, isDark]);

  // Add this within your useEffect function that handles styling
  useEffect(() => {
    if (isClient) {
      // Add the additional styles for required parameters
      const styleElement = document.createElement("style");
      styleElement.textContent = additionalStyles;
      document.head.appendChild(styleElement);

      return () => {
        document.head.removeChild(styleElement);
      };
    }
  }, [isClient, isDark]);

  // Add the following useEffect within your existing component

  useEffect(() => {
    if (isClient) {
      // Additional styles for better required indicators and schemas
      const customStyles = document.createElement("style");
      customStyles.textContent = `
        /* Better Required Indicator Styling */
        .swagger-ui .parameter__name.required {
          position: relative;
          padding-left: 20px !important;
        }
        
        .swagger-ui .parameter__name.required:before {
          content: "*";
          color: #ff4d4f;
          position: absolute;
          left: 5px;
          top: 0;
          font-size: 18px;
          font-weight: bold;
        }
        
        /* Schema section improvements */
        .swagger-ui .model-container {
          background-color: ${
            isDark ? "rgba(30, 30, 30, 0.8)" : "rgba(245, 245, 245, 0.8)"
          };
          padding: 15px;
          border-radius: 8px;
          border: 1px solid ${
            isDark ? "rgba(100, 100, 100, 0.5)" : "rgba(200, 200, 200, 0.8)"
          };
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
          margin: 10px 0;
        }
        
        .swagger-ui .model-title {
          font-weight: 600;
          font-size: 16px;
          color: ${isDark ? "#4fc3f7" : "#1976d2"};
          padding-bottom: 8px;
          border-bottom: 1px solid ${
            isDark ? "rgba(100, 100, 100, 0.5)" : "rgba(200, 200, 200, 0.8)"
          };
          margin-bottom: 12px;
        }
        
        .swagger-ui .model {
          margin-bottom: 12px;
        }
        
        .swagger-ui .property {
          margin: 8px 0;
          font-size: 14px;
        }
        
        .swagger-ui .property-primitive {
          color: ${isDark ? "#81d4fa" : "#0277bd"};
          font-weight: 500;
        }
        
        /* Improve schema tables */
        .swagger-ui table.model {
          width: 100%;
          margin: 10px 0;
        }
        
        .swagger-ui table.model tr.property-row td {
          padding: 8px 10px;
          border-bottom: 1px solid ${
            isDark ? "rgba(100, 100, 100, 0.4)" : "rgba(230, 230, 230, 0.8)"
          };
        }
        
        /* Ensure filter box is styled properly */
        .swagger-ui .filter-container input {
          background-color: ${isDark ? "#2d2d2d" : "#f5f5f5"};
          color: ${isDark ? "#e0e0e0" : "#333"};
          border: 1px solid ${isDark ? "#444" : "#ddd"};
          border-radius: 4px;
          padding: 8px 12px;
          width: 100%;
          box-shadow: ${
            isDark
              ? "inset 0 1px 3px rgba(0,0,0,0.3)"
              : "inset 0 1px 3px rgba(0,0,0,0.1)"
          };
        }
        
        .swagger-ui .filter-container input:focus {
          border-color: ${isDark ? "#64b5f6" : "#2196f3"};
          outline: none;
          box-shadow: ${
            isDark
              ? "0 0 0 3px rgba(100,181,246,0.2), inset 0 1px 3px rgba(0,0,0,0.3)"
              : "0 0 0 3px rgba(33,150,243,0.2), inset 0 1px 3px rgba(0,0,0,0.1)"
          };
        }
        
        /* Fix method badges */
        .swagger-ui .opblock-summary-method {
          border-radius: 4px !important;
          min-width: 80px;
          text-align: center;
          font-weight: bold;
          padding: 6px 0;
        }
        
        /* Fix API path spacing */
        .swagger-ui .opblock-summary-path {
          padding: 0 10px;
        }
        
        /* Add subtle transitions for hover effects */
        .swagger-ui .opblock {
          transition: box-shadow 0.2s ease, transform 0.2s ease;
        }
        
        .swagger-ui .opblock:hover {
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          transform: translateY(-1px);
        }
        
        /* Make schema titles more visible */
        .swagger-ui .schemas-title {
          font-weight: 600;
          font-size: 20px;
          margin: 20px 0 10px;
          color: ${isDark ? "#fff" : "#333"};
        }
        
        /* Improve schema section appearance */
        .swagger-ui section.models {
          border: 1px solid ${
            isDark ? "rgba(100, 100, 100, 0.5)" : "rgba(200, 200, 200, 0.8)"
          };
          border-radius: 8px;
          padding: 15px;
          margin: 20px 0;
          background-color: ${
            isDark ? "rgba(30, 30, 30, 0.5)" : "rgba(250, 250, 250, 0.8)"
          };
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        
        /* Improve model box margins */
        .swagger-ui .model-box {
          margin: 15px 0;
        }
      `;

      document.head.appendChild(customStyles);

      return () => {
        document.head.removeChild(customStyles);
      };
    }
  }, [isClient, isDark]);

  // Add this to your existing styling code

  useEffect(() => {
    if (isClient) {
      // Fix for schema rendering and required indicators
      const styleElement = document.createElement("style");
      styleElement.textContent = `
        /* Fix schema rendering */
        .swagger-ui .model-box {
          background-color: ${
            isDark ? "rgba(30, 30, 30, 0.8)" : "rgba(245, 245, 245, 0.8)"
          };
          border: 1px solid ${
            isDark ? "rgba(80, 80, 80, 0.6)" : "rgba(220, 220, 220, 0.8)"
          };
          border-radius: 6px;
          padding: 12px;
          margin: 10px 0;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
        }
        
        /* Fix required indicator */
        .swagger-ui .parameter__name.required:after {
          content: "*";
          color: #f44336;
          font-size: 18px;
          font-weight: bold;
          margin-left: 3px;
          line-height: 1;
        }
        
        /* Fix padding issues */
        .swagger-ui .parameter__name {
          vertical-align: middle;
          margin-right: 0.5em;
        }
        
        /* Better model property styling */
        .swagger-ui .model .property {
          padding: 5px 0;
          font-size: 14px;
        }
        
        /* Better schema section styling */
        .swagger-ui section.models {
          padding: 20px;
          background: ${isDark ? "#1e1e1e" : "#f8f8f8"};
          border-radius: 8px;
          border: 1px solid ${isDark ? "#444" : "#ddd"};
          margin-top: 20px;
        }
        
        .swagger-ui section.models h4 {
          font-size: 18px;
          font-weight: 600;
          margin-top: 0;
          margin-bottom: 15px;
          color: ${isDark ? "#fff" : "#333"};
        }
        
        /* Fix type display */
        .swagger-ui .model .property .property-type {
          color: ${isDark ? "#4fc3f7" : "#0277bd"};
          font-weight: 500;
        }
        
        /* Fix method buttons */
        .swagger-ui .opblock-summary-method {
          border-radius: 4px;
          font-weight: 600;
          min-width: 80px;
          text-align: center;
        }
        
        /* Fix path display */
        .swagger-ui .opblock-summary-path {
          font-family: monospace;
          font-weight: 500;
          padding: 0 10px;
        }
        
        /* Fix operation spacing */
        .swagger-ui .opblock {
          margin-bottom: 15px;
        }
      `;

      document.head.appendChild(styleElement);

      return () => {
        document.head.removeChild(styleElement);
      };
    }
  }, [isClient, isDark]);

  const apiSpecUrl = "/api/docs";

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <CssBaseline />

      <Container maxWidth="xl" sx={{ mt: 4, mb: 4, flexGrow: 1 }}>
        <Paper
          elevation={2}
          sx={{
            p: 3,
            mb: 3,
            borderRadius: 2,
            background: isDark
              ? alpha(theme.palette.primary.main, 0.05)
              : alpha(theme.palette.primary.main, 0.03),
          }}
        >
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
            <ApiIcon sx={{ fontSize: 40, color: theme.palette.primary.main }} />
            <Typography variant="h4" component="h1">
              FLUJO API Reference
            </Typography>
            <Chip
              label={`v${version}`}
              size="small"
              color="primary"
              sx={{ height: 24, ml: 2 }}
            />
          </Stack>

          <Typography variant="body1" sx={{ mb: 1 }}>
            Complete API documentation for integrating with FLUJO's headless
            mode
          </Typography>
          <Divider sx={{ my: 2 }} />

          <Stack
            direction="row"
            spacing={2}
            sx={{ mt: 2 }}
            justifyContent="space-between"
            alignItems="center"
          >
            <Box>
              <Chip
                label="OpenAI-Compatible API"
                variant="outlined"
                color="success"
                size="small"
                sx={{ mr: 1 }}
              />
              <Chip
                label="Flow Execution"
                variant="outlined"
                color="info"
                size="small"
                sx={{ mr: 1 }}
              />
              <Chip
                label="MCP Server Management"
                variant="outlined"
                color="secondary"
                size="small"
              />
            </Box>

            {ENABLE_MODERN_UI_TOGGLE && (
              <FormControlLabel
                control={
                  <Switch
                    checked={useModernUI}
                    onChange={(e) => setUseModernUI(e.target.checked)}
                    name="uiToggle"
                    color="primary"
                  />
                }
                label="Use Modern UI"
              />
            )}
          </Stack>
        </Paper>

        <Paper
          elevation={3}
          sx={{
            borderRadius: 2,
            overflow: "hidden",
            ".swagger-ui": {
              ".topbar": { display: "none" },
              ".information-container": { display: "none" },
              ".scheme-container": {
                boxShadow: "none",
                backgroundColor: "transparent",
                padding: "0 30px",
              },
              // Base theme styles
              color: theme.palette.text.primary,
              fontFamily: theme.typography.fontFamily,

              // Headers
              "h2, h3": {
                color: theme.palette.primary.main,
                fontFamily: theme.typography.fontFamily,
              },

              // Operation containers
              ".opblock-tag": {
                borderBottom: `1px solid ${theme.palette.divider}`,
                marginBottom: "10px",
                padding: "10px 20px",
                background: "transparent",
                color: theme.palette.text.primary,
              },
              ".opblock": {
                margin: "0 0 15px",
                borderRadius: "6px",
                boxShadow: isDark
                  ? "0 2px 5px rgba(0,0,0,0.3)"
                  : "0 2px 5px rgba(0,0,0,0.1)",
                border: "none",
                overflow: "hidden",
                backgroundColor: isDark
                  ? alpha(theme.palette.background.paper, 0.7)
                  : theme.palette.background.paper,
              },
              ".opblock-summary": {
                padding: "10px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              },

              // Style improvements for expanded operations
              ".opblock.is-open .opblock-summary": {
                borderBottomLeftRadius: 0,
                borderBottomRightRadius: 0,
                borderBottom: `1px solid ${theme.palette.divider}`,
              },

              // Ensure the method labels and descriptions are properly aligned
              ".opblock-summary-control": {
                display: "flex",
                alignItems: "center",
                flex: 1,
              },

              // Ensure descriptions have proper spacing and don't wrap awkwardly
              ".opblock-summary-description": {
                textIndent: 0,
                marginLeft: "10px",
                fontSize: "14px",
                fontWeight: "normal",
                color: isDark ? "#ffffff" : "#333333",
                lineHeight: 1.5,
                padding: "0 8px",
                fontFamily: theme.typography.fontFamily,
                flexGrow: 1,
                display: "inline-block",
              },

              // Improve overall layout consistency
              ".opblock-body": {
                padding: "10px 20px",
              },

              // Fix the padding and margins for better readability
              ".opblock-section": {
                padding: "10px 0",
              },

              // Improve method spacing and description visibility
              ".opblock-summary-method": {
                borderRadius: "4px",
                padding: "6px 12px",
                fontWeight: "bold",
                fontSize: "14px",
                textShadow: "0 1px 1px rgba(0,0,0,0.5)",
                color: "#ffffff !important",
              },

              // Better spacing for parameter sections
              ".parameters-container": {
                padding: "10px 0",
              },

              ".parameter__name": {
                fontSize: "14px",
                fontWeight: "500",
                fontFamily: theme.typography.fontFamily,
              },

              ".parameter__in": {
                fontSize: "12px",
                color: theme.palette.text.secondary,
              },

              // Better rendering of parameter descriptions
              ".parameter__description": {
                marginTop: "5px",
                fontSize: "13px",
                lineHeight: "1.4",
                color: theme.palette.text.secondary,
              },

              // Fix schemas and models display
              ".model-box": {
                padding: "12px",
                borderRadius: "4px",
                border: `1px solid ${theme.palette.divider}`,
                backgroundColor: isDark
                  ? alpha(theme.palette.background.default, 0.6)
                  : theme.palette.background.default,
              },

              // Fix table layouts
              "table.model": {
                marginTop: "10px",
                borderCollapse: "separate",
                borderSpacing: "0 2px",
              },

              "table.model td": {
                padding: "8px 10px",
                fontSize: "13px",
                borderBottom: `1px solid ${theme.palette.divider}`,
              },

              // GET operation
              ".opblock-get": {
                borderColor: theme.palette.success.main,
                background: alpha(theme.palette.success.main, 0.05),
                ".opblock-summary": {
                  borderColor: theme.palette.success.main,
                },
                ".opblock-summary-method": {
                  backgroundColor: theme.palette.success.main,
                  color: "#ffffff !important",
                },
              },

              // POST operation
              ".opblock-post": {
                borderColor: theme.palette.primary.main,
                background: alpha(theme.palette.primary.main, 0.05),
                ".opblock-summary": {
                  borderColor: theme.palette.primary.main,
                },
                ".opblock-summary-method": {
                  backgroundColor: theme.palette.primary.main,
                  color: "#ffffff !important",
                },
              },

              // PUT operation
              ".opblock-put": {
                borderColor: theme.palette.warning.main,
                background: alpha(theme.palette.warning.main, 0.05),
                ".opblock-summary": {
                  borderColor: theme.palette.warning.main,
                },
                ".opblock-summary-method": {
                  backgroundColor: theme.palette.warning.main,
                  color: "#000000 !important",
                },
              },

              // DELETE operation
              ".opblock-delete": {
                borderColor: theme.palette.error.main,
                background: alpha(theme.palette.error.main, 0.05),
                ".opblock-summary": {
                  borderColor: theme.palette.error.main,
                },
                ".opblock-summary-method": {
                  backgroundColor: theme.palette.error.main,
                  color: "#ffffff !important",
                },
              },

              // Inputs
              ".parameters-col_name": {
                fontSize: "14px",
                fontFamily: theme.typography.fontFamily,
                color: theme.palette.text.primary,
                fontWeight: "600",
              },
              ".parameter__type": {
                fontSize: "12px",
                color: theme.palette.text.secondary,
              },
              "input[type=text]": {
                padding: "8px 12px",
                borderRadius: "4px",
                border: `1px solid ${theme.palette.divider}`,
                background: theme.palette.background.paper,
                color: theme.palette.text.primary,
              },
              "button.btn": {
                borderRadius: "4px",
                boxShadow: "none",
                backgroundColor: theme.palette.primary.main,
                color: theme.palette.primary.contrastText,
                fontWeight: theme.typography.fontWeightMedium,
                "&:hover": {
                  backgroundColor: theme.palette.primary.dark,
                },
              },
              ".response-col_status": {
                fontWeight: "600",
                color: theme.palette.text.primary,
              },
              ".response": {
                padding: "15px",
                backgroundColor: isDark
                  ? alpha(theme.palette.background.paper, 0.5)
                  : alpha(theme.palette.background.default, 0.5),
              },

              // Response section
              ".response-col_description__inner p": {
                color: theme.palette.text.primary,
                fontFamily: theme.typography.fontFamily,
              },
              ".response-control-media-type__accept-message": {
                color: theme.palette.text.secondary,
              },

              // Model section - Enhanced
              ".model": {
                color: theme.palette.text.primary,
                fontSize: "14px",
                fontFamily: theme.typography.fontFamily,
              },
              ".model-title": {
                color: theme.palette.primary.main,
              },
              ".property": {
                color: theme.palette.text.primary,
                fontSize: "14px",
              },
              ".property-primitive": {
                color: isDark
                  ? theme.palette.primary.light
                  : theme.palette.primary.main,
              },

              // Tables
              table: {
                borderCollapse: "separate",
                borderSpacing: "0",
                backgroundColor: "transparent",
                th: {
                  border: `1px solid ${theme.palette.divider}`,
                  borderRadius: "4px 4px 0 0",
                  padding: "10px",
                  backgroundColor: isDark
                    ? alpha(theme.palette.background.paper, 0.8)
                    : alpha(theme.palette.background.default, 0.8),
                  color: theme.palette.text.primary,
                },
                td: {
                  border: `1px solid ${theme.palette.divider}`,
                  padding: "10px",
                  backgroundColor: isDark
                    ? alpha(theme.palette.background.paper, 0.5)
                    : "transparent",
                  color: theme.palette.text.primary,
                },
              },

              // Code blocks
              ".highlight-code": {
                backgroundColor: isDark ? "#2d2d2d" : "#f6f8fa",
                color: isDark ? "#e6e6e6" : "#24292e",
              },

              // Better swagger reference links
              ".swagger-ui a.nostyle": {
                color: theme.palette.primary.main,
              },

              // Also enhance color scheme for method labels on dark theme
              ...(isDark
                ? {
                    ".opblock-summary-method": {
                      fontSize: "14px",
                      color: "#ffffff !important",
                      borderRadius: "4px",
                      fontWeight: "bold",
                      textShadow: "0 1px 2px rgba(0,0,0,0.7)",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                    },
                    ".opblock-get .opblock-summary-method": {
                      backgroundColor: "#2E8B57 !important", // Darker green
                    },
                    ".opblock-post .opblock-summary-method": {
                      backgroundColor: "#105CBC !important", // Darker blue
                    },
                    ".opblock-put .opblock-summary-method": {
                      backgroundColor: "#d97706 !important", // Darker amber
                      color: "#ffffff !important",
                    },
                    ".opblock-delete .opblock-summary-method": {
                      backgroundColor: "#b91c1c !important", // Darker red
                    },
                    // Ensure dark mode has proper contrast for operation backgrounds
                    ".opblock": {
                      backgroundColor: alpha("#121212", 0.95),
                    },
                    ".opblock-summary": {
                      backgroundColor: alpha("#1e1e1e", 0.9),
                    },
                    // Improve dark mode contrast for operation descriptions
                    ".opblock-summary-description": {
                      color: "#ffffff !important",
                      textShadow: "0 1px 1px rgba(0,0,0,0.5)",
                    },
                    // Add contrast to dark mode backgrounds for better readability
                    ".opblock-section-header": {
                      backgroundColor: "#1a1a1a !important",
                      color: "#ffffff !important",
                      padding: "8px 12px",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                    },
                    ".opblock-section-header h4": {
                      color: "#ffffff !important",
                    },
                    // Enhance endpoint paths in dark mode
                    ".opblock-summary-path": {
                      fontSize: "14px",
                      fontWeight: "500",
                      color: "#4fc3f7 !important", // Light blue for better visibility
                    },
                    ".opblock-summary-path__deprecated": {
                      color: "#ff9800 !important", // Orange for deprecated paths
                    },
                    // Make URL stand out in dark mode
                    ".curl-command": {
                      backgroundColor: "#1a1a1a !important",
                    },
                    ".curl": {
                      color: "#ffffff !important",
                    },
                    ".url": {
                      color: "#4fc3f7 !important",
                    },
                    // Improve parameter names in dark mode
                    ".parameters-col_name": {
                      color: "#ffffff !important",
                    },
                    ".parameter__name": {
                      color: "#eeeeee !important",
                    },
                    // Improve headers in dark mode
                    ".opblock-tag": {
                      color: "#ffffff !important",
                      fontWeight: "600",
                      backgroundColor: alpha("#1e1e1e", 0.7),
                      borderRadius: "4px",
                      marginBottom: "15px",
                    },
                    // Make server selector more visible in dark mode
                    ".servers-title": {
                      color: "#ffffff !important",
                    },
                    ".servers > label": {
                      color: "#ffffff !important",
                    },
                    ".servers select": {
                      backgroundColor: "#2a2a2a !important",
                      color: "#ffffff !important",
                      border: "1px solid #444 !important",
                    },
                    ".servers-title + div .servers": {
                      borderRadius: "4px",
                      padding: "10px",
                      backgroundColor: alpha("#2a2a2a", 0.5),
                    },

                    // Improve path parameter highlighting
                    ".path-param": {
                      color: "#f48fb1 !important", // Pink color for path parameters
                    },

                    // Fix scheme-container in dark mode
                    ".scheme-container": {
                      backgroundColor: "transparent !important",
                    },

                    // Fix response tabs in dark mode
                    ".tab-header": {
                      color: "#ffffff !important",
                    },

                    // Fix response sections in dark mode
                    ".response-col_status": {
                      color: "#ffffff !important",
                    },
                    ".response-col_description": {
                      color: "#ffffff !important",
                    },

                    // Improve the JSON editor and request body areas
                    ".body-param__text": {
                      backgroundColor: "#1a1a1a !important",
                      color: "#f0f0f0 !important",
                      fontFamily: "monospace",
                      fontSize: "13px",
                      border: "1px solid #444 !important",
                      borderRadius: "6px",
                      padding: "15px",
                      boxShadow: "inset 0 1px 3px rgba(0,0,0,0.4)",
                    },

                    // Improve text area inputs
                    textarea: {
                      backgroundColor: "#1a1a1a !important",
                      color: "#f0f0f0 !important",
                      fontFamily: "monospace",
                      border: "1px solid #444 !important",
                      borderRadius: "6px",
                      padding: "10px 15px",
                      boxShadow: "inset 0 1px 3px rgba(0,0,0,0.4)",
                      "&:focus": {
                        borderColor: theme.palette.primary.main + " !important",
                        boxShadow: `0 0 0 2px ${alpha(
                          theme.palette.primary.main,
                          0.3
                        )}, inset 0 1px 3px rgba(0,0,0,0.4)`,
                        outline: "none",
                      },
                    },

                    // Highlight request bodies
                    ".opblock-body pre": {
                      backgroundColor: "#1a1a1a !important",
                      color: "#f0f0f0 !important",
                      border: "1px solid #444 !important",
                      borderRadius: "6px",
                      padding: "15px",
                      boxShadow: "inset 0 1px 3px rgba(0,0,0,0.4)",
                      fontFamily: "monospace",
                      fontSize: "13px",
                      lineHeight: 1.5,
                    },

                    // Fix text in body parameters
                    ".body-param__example": {
                      color: "#f0f0f0 !important",
                    },

                    // Fix text in parameter descriptions
                    ".parameter__name, .parameter__type, .parameter__deprecated, .parameter__in":
                      {
                        color: "#e0e0e0 !important",
                      },

                    // Fix parameter description text
                    ".parameter__description": {
                      color: "#cccccc !important",
                    },

                    // Improve background for expanded sections
                    ".opblock-body": {
                      backgroundColor: alpha("#121212", 0.95) + " !important",
                      padding: "20px",
                      borderBottomLeftRadius: "8px",
                      borderBottomRightRadius: "8px",
                    },

                    // Fix required labels
                    ".parameter__name.required span": {
                      color: "#ff6b6b !important",
                      fontWeight: "bold",
                    },

                    // Add a clearer required indicator
                    ".parameter__name.required:after": {
                      content: '"*"',
                      color: "#ff6b6b !important",
                      fontSize: "18px",
                      fontWeight: "bold",
                      marginLeft: "5px",
                      display: "inline-block",
                      textShadow: "0 0 3px rgba(255,0,0,0.3)",
                    },

                    // Better response examples
                    ".highlight-code": {
                      backgroundColor: "#1a1a1a !important",
                      color: "#e0e0e0 !important",
                      padding: "15px",
                      borderRadius: "6px",
                      border: "1px solid #444 !important",
                      boxShadow: "inset 0 1px 3px rgba(0,0,0,0.4)",
                      fontSize: "13px",
                      fontFamily: "monospace",
                      lineHeight: 1.5,
                    },

                    // Fix JSON property coloring
                    ".property-primitive": {
                      color: "#81d4fa !important", // Light blue for properties
                    },

                    // Fix request buttons
                    "button.btn": {
                      backgroundColor: "#2196f3 !important",
                      color: "white !important",
                      border: "none !important",
                      boxShadow: "0 2px 4px rgba(0,0,0,0.3) !important",
                      borderRadius: "6px !important",
                      padding: "10px 16px !important",
                      fontWeight: "600 !important",
                      fontSize: "14px !important",
                      letterSpacing: "0.5px !important",
                      transition: "all 0.2s ease !important",
                    },
                    "button.btn:hover": {
                      backgroundColor: "#1976d2 !important",
                      boxShadow: "0 3px 6px rgba(0,0,0,0.4) !important",
                      transform: "translateY(-1px) !important",
                    },
                    "button.btn:active": {
                      backgroundColor: "#0d47a1 !important",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.3) !important",
                      transform: "translateY(1px) !important",
                    },
                    "button.btn-clear": {
                      backgroundColor: "#616161 !important",
                      color: "white !important",
                    },
                    "button.btn-clear:hover": {
                      backgroundColor: "#757575 !important",
                    },

                    // Fix Cancel button
                    "button.cancel": {
                      backgroundColor: "#616161 !important",
                      border: "none !important",
                      borderRadius: "6px !important",
                      color: "white !important",
                      boxShadow: "0 2px 4px rgba(0,0,0,0.3) !important",
                      padding: "10px 16px !important",
                      fontWeight: "600 !important",
                    },
                    "button.cancel:hover": {
                      backgroundColor: "#757575 !important",
                      boxShadow: "0 3px 6px rgba(0,0,0,0.4) !important",
                      transform: "translateY(-1px) !important",
                    },

                    // Fix the Execute button
                    ".execute": {
                      backgroundColor: "#4CAF50 !important",
                      border: "none !important",
                      borderRadius: "6px !important",
                      boxShadow: "0 2px 4px rgba(0,0,0,0.3) !important",
                      padding: "10px 16px !important",
                      fontWeight: "600 !important",
                      fontSize: "14px !important",
                      letterSpacing: "0.5px !important",
                      transition: "all 0.2s ease !important",
                    },
                    ".execute:hover": {
                      backgroundColor: "#388E3C !important",
                      boxShadow: "0 3px 6px rgba(0,0,0,0.4) !important",
                      transform: "translateY(-1px) !important",
                    },

                    // Better parameter rows styling
                    ".parameters tr td": {
                      backgroundColor: alpha("#1e1e1e", 0.5) + " !important",
                      borderBottom: `1px solid ${alpha(
                        theme.palette.divider,
                        0.6
                      )} !important`,
                      padding: "15px !important",
                    },

                    // Table headers
                    "table thead tr th": {
                      backgroundColor: "#1a1a1a !important",
                      color: "#ffffff !important",
                      fontWeight: "600 !important",
                      padding: "12px 15px !important",
                      borderBottom: `2px solid ${alpha(
                        theme.palette.divider,
                        0.8
                      )} !important`,
                    },

                    // Better schema styling
                    ".model-container": {
                      backgroundColor: alpha("#1a1a1a", 0.8) + " !important",
                      borderRadius: "8px !important",
                      padding: "15px !important",
                      boxShadow: "0 2px 6px rgba(0,0,0,0.3) !important",
                      border: `1px solid ${alpha(
                        theme.palette.divider,
                        0.7
                      )} !important`,
                      margin: "15px 0 !important",
                    },

                    // Fix model schema titles
                    ".model-title": {
                      color: theme.palette.primary.light + " !important",
                      fontWeight: "600 !important",
                      fontSize: "16px !important",
                      padding: "6px 0 !important",
                      borderBottom: `1px solid ${alpha(
                        theme.palette.divider,
                        0.7
                      )} !important`,
                      marginBottom: "10px !important",
                    },

                    // Code variable highlighting
                    ".variable-highlighted": {
                      color: "#FF9800 !important",
                      fontWeight: "bold !important",
                    },

                    // Headers for expanded sections
                    ".opblock h4": {
                      color: "#ffffff !important",
                      fontWeight: "600 !important",
                      fontSize: "16px !important",
                      margin: "10px 0 !important",
                    },

                    // Authorization inputs
                    ".authorization__btn": {
                      backgroundColor:
                        theme.palette.primary.main + " !important",
                      color: "#ffffff !important",
                      borderRadius: "6px !important",
                      boxShadow: "0 2px 4px rgba(0,0,0,0.3) !important",
                      border: "none !important",
                      padding: "8px 15px !important",
                      fontWeight: "600 !important",
                      transition: "all 0.2s ease !important",
                    },
                    ".authorization__btn:hover": {
                      backgroundColor:
                        theme.palette.primary.dark + " !important",
                      boxShadow: "0 3px 6px rgba(0,0,0,0.4) !important",
                    },

                    // Authorization modal
                    ".dialog-ux": {
                      backgroundColor: "#212121 !important",
                      borderRadius: "8px !important",
                      boxShadow: "0 5px 15px rgba(0,0,0,0.5) !important",
                      border: `1px solid ${alpha(
                        theme.palette.divider,
                        0.8
                      )} !important`,
                    },
                    ".dialog-ux .modal-ux-header": {
                      borderBottom: `1px solid ${alpha(
                        theme.palette.divider,
                        0.8
                      )} !important`,
                      backgroundColor: "#1a1a1a !important",
                      padding: "15px !important",
                      borderTopLeftRadius: "8px !important",
                      borderTopRightRadius: "8px !important",
                    },
                    ".dialog-ux .modal-ux-header h3": {
                      color: "#ffffff !important",
                      fontWeight: "600 !important",
                    },
                    ".dialog-ux .modal-ux-content": {
                      padding: "20px !important",
                    },
                  }
                : {}),
            },
          }}
        >
          {isClient &&
            (useModernUI ? (
              <ModernSwaggerUI url={apiSpecUrl} />
            ) : (
              <SwaggerUI
                url={apiSpecUrl}
                docExpansion="list"
                deepLinking={true}
                displayOperationId={false}
                tryItOutEnabled={true}
              />
            ))}
        </Paper>
      </Container>
    </Box>
  );
}
