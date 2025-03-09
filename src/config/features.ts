/**
 * Feature flags for the application
 * 
 * This file contains feature flags that can be used to enable or disable
 * specific features of the application.
 */
export const FEATURES = {
  /**
   * Controls whether Server-Sent Events (SSE) functionality is enabled
   * When set to false, no SSE connections will be established
   */
  SSE_ENABLED: false, // Set to false to disable SSE

  /**
   * Controls the application's logging level
   * Possible values:
   * - 0: DEBUG (most verbose)
   * - 1: INFO
   * - 2: WARN
   * - 3: ERROR (least verbose)
   * 
   * Only log messages with a level greater than or equal to this value will be displayed
   */
  LOG_LEVEL: 0, // Default to ERROR level
};
