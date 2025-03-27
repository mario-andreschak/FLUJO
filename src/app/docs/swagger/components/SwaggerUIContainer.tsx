import React from 'react';
import { Box, useTheme } from '@mui/material';
import dynamic from "next/dynamic";

// Interfaces
interface SwaggerUIComponentProps {
  url: string;
  docExpansion?: string;
  deepLinking?: boolean;
  tryItOutEnabled?: boolean;
  defaultModelsExpandDepth?: number;
  displayOperationId?: boolean;
  filter?: boolean;
  showExtensions?: boolean;
  requestInterceptor?: (req: any) => any;
  responseInterceptor?: (res: any) => any;
}

// Dynamic imports for the UI components
const SwaggerUIWrapper = dynamic(
  () => import("../SwaggerUIWrapper").then(mod => mod.default),
  { ssr: false }
);

const ModernSwaggerUI = dynamic(
  () => import("../ModernSwaggerUI").then(mod => mod.default),
  { ssr: false }
);

interface SwaggerUIContainerProps {
  useModernUI: boolean;
  apiSpecUrl: string;
  isClient: boolean;
  requestInterceptor: (req: any) => any;
  responseInterceptor: (res: any) => any;
}

/**
 * Container component for Swagger UI
 * Conditionally renders either the standard or modern UI based on props
 */
const SwaggerUIContainer: React.FC<SwaggerUIContainerProps> = ({
  useModernUI,
  apiSpecUrl,
  isClient,
  requestInterceptor,
  responseInterceptor
}) => {
  const theme = useTheme();

  if (!isClient) {
    return null;
  }

  return (
    <>
      {useModernUI ? (
        // @ts-ignore - Props are passed correctly to ModernSwaggerUI
        <ModernSwaggerUI url={apiSpecUrl} />
      ) : (
        <Box 
          className="swagger-ui-container" 
          sx={{ 
            flex: 1,
            position: 'relative',
            '.swagger-ui .wrapper': {
              padding: 0,
              maxWidth: 'none'
            },
            '.swagger-ui': {
              'h2, h3': {
                color: theme.palette.text.primary
              }
            }
          }}
        >
          {/* @ts-ignore - Props are passed correctly to SwaggerUIWrapper */}
          <SwaggerUIWrapper 
            url={apiSpecUrl}
            docExpansion="list"
            deepLinking={true}
            tryItOutEnabled={true}
            defaultModelsExpandDepth={-1}
            displayOperationId={false}
            filter={true}
            showExtensions={true}
            requestInterceptor={requestInterceptor}
            responseInterceptor={responseInterceptor}
          />
        </Box>
      )}
    </>
  );
};

export default SwaggerUIContainer; 