import { useCallback } from 'react';
import { createLogger } from '@/utils/logger';

// Create a logger for the Swagger interceptors
const log = createLogger("app/docs/swagger/hooks/useSwaggerInterceptors");

interface SwaggerRequest {
  url: string;
  [key: string]: any;
}

interface SwaggerResponse {
  status: number;
  [key: string]: any;
}

/**
 * A custom hook to provide request and response interceptors for Swagger UI
 * 
 * @returns {Object} Object containing requestInterceptor and responseInterceptor functions
 */
export const useSwaggerInterceptors = () => {
  /**
   * Request interceptor for Swagger UI
   * Ensures requests are sent to the correct API endpoint
   * 
   * @param {SwaggerRequest} req - The request object
   * @returns {SwaggerRequest} The modified request object
   */
  const requestInterceptor = useCallback((req: SwaggerRequest): SwaggerRequest => {
    // Log the original request for debugging
    log.debug(`Intercepting request to: ${req.url}`);
    
    // Make sure requests are being sent to the right endpoint
    if (!req.url.startsWith('/api/') && req.url.startsWith('/')) {
      req.url = `/api${req.url}`;
      log.debug(`Modified request URL: ${req.url}`);
    }
    
    // Add headers if needed
    if (!req.headers) {
      req.headers = {};
    }
    
    // Example of adding a header if needed:
    // req.headers['x-custom-header'] = 'custom-value';
    
    return req;
  }, []);

  /**
   * Response interceptor for Swagger UI
   * Logs response status and can be extended to modify responses
   * 
   * @param {SwaggerResponse} res - The response object
   * @returns {SwaggerResponse} The response object, potentially modified
   */
  const responseInterceptor = useCallback((res: SwaggerResponse): SwaggerResponse => {
    // Log the response for debugging
    log.debug(`Response status: ${res.status}`);
    
    // Handle specific response status codes if needed
    if (res.status >= 400) {
      log.warn(`API error response: ${res.status}`);
    }
    
    return res;
  }, []);

  return {
    requestInterceptor,
    responseInterceptor
  };
};

export default useSwaggerInterceptors; 