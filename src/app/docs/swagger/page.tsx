"use client";

import React, { useEffect, useState } from "react";
import {
  Container,
  CssBaseline,
  Paper,
  alpha,
  useTheme,
  useMediaQuery,
} from "@mui/material";
import { createLogger } from "@/utils/logger";

// Import custom hooks
import useSwaggerStyles from "./hooks/useSwaggerStyles";
import useSwaggerTheme from "./hooks/useSwaggerTheme";
import useSwaggerInterceptors from "./hooks/useSwaggerInterceptors";

// Import components
import SwaggerHeader from "./components/SwaggerHeader";
import SwaggerUIContainer from "./components/SwaggerUIContainer";

// Create a logger for the Swagger page
const log = createLogger("app/docs/swagger/page");

// This flag determines if we should show the modern UI toggle
// Setting to false by default as the modern UI is still in development
const ENABLE_MODERN_UI_TOGGLE = false;

/**
 * SwaggerPage component for displaying API documentation
 */
export default function SwaggerPage() {
  const theme = useTheme();
  const isSmallScreen = useMediaQuery(theme.breakpoints.down("md"));
  const [useModernUI, setUseModernUI] = useState(false);
  const [isClient, setIsClient] = useState(false);

  // Detect client-side rendering
  useEffect(() => {
    setIsClient(true);
  }, []);

  // API specification URL - must be absolute for Swagger UI
  const apiSpecUrl = "/api/docs";

  // Apply custom hooks for styling and theme integration
  useSwaggerStyles(isClient, useModernUI);
  useSwaggerTheme(isClient);
  const { requestInterceptor, responseInterceptor } = useSwaggerInterceptors();

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <CssBaseline />
        <Paper
          elevation={2}
          sx={{
          p: isSmallScreen ? 2 : 4,
          position: "relative",
          overflow: "hidden",
          minHeight: "calc(100vh - 220px)",
          display: "flex",
          flexDirection: "column",
          bgcolor: (theme) =>
            alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.8 : 1),
          backdropFilter: "blur(8px)",
        }}
      >
        <SwaggerHeader 
          useModernUI={useModernUI}
          setUseModernUI={setUseModernUI}
          enableModernUIToggle={ENABLE_MODERN_UI_TOGGLE}
        />

        <SwaggerUIContainer
          useModernUI={useModernUI}
          apiSpecUrl={apiSpecUrl}
          isClient={isClient}
          requestInterceptor={requestInterceptor}
          responseInterceptor={responseInterceptor}
        />
        </Paper>
      </Container>
  );
}
