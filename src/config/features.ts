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
   * - -1: VERBOSE (most verbose)
   * - 0: DEBUG
   * - 1: INFO
   * - 2: WARN
   * - 3: ERROR (least verbose)
   * 
   * Only log messages with a level greater than or equal to this value will be displayed
   */
  LOG_LEVEL: -1, // VERBOSE level for debugging
  
  /**
   * Controls whether tool calls are included in the response
   * When set to true, tool calls will be included in the response
   * When set to false, tool calls will be processed but not included in the response
   */
  INCLUDE_TOOL_CALLS_IN_RESPONSE: true,
};
