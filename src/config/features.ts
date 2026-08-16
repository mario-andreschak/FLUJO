/**
 * Feature flags for the application
 * 
 * This file contains feature flags that can be used to enable or disable
 * specific features of the application.
 */
export const FEATURES = {
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
  LOG_LEVEL: 3, // VERBOSE level for debugging
  
  /**
   * Controls whether tool calls are included in the response
   * When set to true, tool calls will be included in the response
   * When set to false, tool calls will be processed but not included in the response
   */
  INCLUDE_TOOL_CALLS_IN_RESPONSE: true,
  
  /**
   * Controls whether the execution tracker is enabled
   * When true, node execution history will be tracked in sharedState.trackingInfo.nodeExecutionTracker
   * When false, the nodeExecutionTracker array will not be created or updated
   */
  ENABLE_EXECUTION_TRACKER: false, // Enabled by default

  /** Admit durable post-Activity Behavior assessment records. Shadow rollout is opt-in. */
  ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION: false,

  /** Permit diagnosis work after admission. Independent so admission can be observed safely. */
  ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS: false,

  /**
   * MCP Tasks extension (issue #404), CLIENT side.
   *
   * When true, FLUJO may request task-augmented execution (`params.task`) from
   * servers that advertise `capabilities.tasks.requests.tools.call`, and runs
   * the durable poll/cancel lifecycle in
   * backend/services/mcp/clientTasks.ts.
   *
   * Default OFF: the Tasks APIs in @modelcontextprotocol/sdk 1.30.0 are still
   * marked experimental, and this flag governs BOTH negotiation and durable
   * record creation so FLUJO never advertises or half-implements the extension.
   * A server that returns a schema-valid task handle anyway is still handled
   * (never misread as a tool result) — see shared/types/mcp/tasks.ts.
   */
  ENABLE_MCP_TASKS_CLIENT: false,

  /**
   * MCP Tasks extension, SERVER side (FLUJO's own /mcp-proxy and /mcp-flows
   * endpoints). Kept OFF and unimplemented on purpose: neither endpoint can
   * currently bind a stable caller identity to a task, and task-id-only lookup
   * across stateless Streamable HTTP requests would be an authorization hole.
   * See docs/mcp-tasks.md ("Server-side status").
   */
  ENABLE_MCP_TASKS_SERVER: false,

  /** Enable automatic expiry of untouched memory candidates (issue #452). */
  ENABLE_MEMORY_CANDIDATE_EXPIRY: true,

  /** Enable automatic promotion of corroborated memory candidates to active status (issue #452). Default OFF for safety. */
  ENABLE_MEMORY_AUTO_PROMOTION: false,

  /** Enable conflict detection and linking of contradictory memory facts (issue #452). */
  ENABLE_MEMORY_CONFLICT_SURFACING: true,

  /** Enable retention/compaction of Persona mailbox, activities, dispatches, and lease history (issue #453). */
  ENABLE_PERSONA_RUNTIME_RETENTION: false,
};
