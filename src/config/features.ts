/**
 * Feature flags for the application
 * 
 * This file contains feature flags that can be used to enable or disable
 * specific features of the application.
 */

export interface PersonaRuntimeEventLogConfig {
  maxSegmentBytes: number;
  maxSegmentEvents: number;
  /** Nonpositive values disable destructive closed-segment retention. */
  retentionDays: number;
  /** Newest closed segments protected from age-based retention. */
  maxClosedSegments: number;
}

export const PERSONA_RUNTIME_EVENT_LOG_DEFAULT_CONFIG:
  PersonaRuntimeEventLogConfig = Object.freeze({
    maxSegmentBytes: 8 * 1024 * 1024,
    maxSegmentEvents: 20_000,
    retentionDays: 0,
    maxClosedSegments: 30,
  });

function parseSafeInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
): number | null {
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

/**
 * Read the deployment-owned runtime event-log policy. Malformed input fails
 * closed: rotation keeps its bounded defaults and retention is disabled.
 */
export function readPersonaRuntimeEventLogConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PersonaRuntimeEventLogConfig {
  const maxSegmentBytes = parseSafeInteger(
    env.FLUJO_PERSONA_RUNTIME_EVENT_SEGMENT_MAX_BYTES,
    PERSONA_RUNTIME_EVENT_LOG_DEFAULT_CONFIG.maxSegmentBytes,
    1,
  );
  const maxSegmentEvents = parseSafeInteger(
    env.FLUJO_PERSONA_RUNTIME_EVENT_SEGMENT_MAX_EVENTS,
    PERSONA_RUNTIME_EVENT_LOG_DEFAULT_CONFIG.maxSegmentEvents,
    1,
  );
  const retentionDays = parseSafeInteger(
    env.FLUJO_PERSONA_RUNTIME_EVENT_RETENTION_DAYS,
    PERSONA_RUNTIME_EVENT_LOG_DEFAULT_CONFIG.retentionDays,
    0,
  );
  const maxClosedSegments = parseSafeInteger(
    env.FLUJO_PERSONA_RUNTIME_EVENT_MAX_CLOSED_SEGMENTS,
    PERSONA_RUNTIME_EVENT_LOG_DEFAULT_CONFIG.maxClosedSegments,
    0,
  );
  if (
    maxSegmentBytes === null
    || maxSegmentEvents === null
    || retentionDays === null
    || maxClosedSegments === null
  ) {
    return { ...PERSONA_RUNTIME_EVENT_LOG_DEFAULT_CONFIG };
  }
  return { maxSegmentBytes, maxSegmentEvents, retentionDays, maxClosedSegments };
}

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
  LOG_LEVEL: 3, // ERROR by default; use -1 for verbose diagnostics.
  
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

  /**
   * Permit diagnosis work after admission. Kept separate from admission so
   * shadow evidence collection remains available.
   */
  ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS: false,

  /**
   * MCP Tasks extension (issue #404), CLIENT side, on every transport.
   *
   * Governs modern per-request extension negotiation, the retained 2025
   * per-tool augmentation and durable task records together. FLUJO only asks
   * for a task when the server advertises Tasks. Input remains attended and
   * server-policy controlled. On by default; FLUJO_MCP_TASKS_CLIENT=false
   * turns it off.
   */
  get ENABLE_MCP_TASKS_CLIENT(): boolean {
    return process.env.FLUJO_MCP_TASKS_CLIENT?.trim().toLowerCase() !== 'false';
  },

  /**
   * MCP Tasks extension, SERVER side (/mcp-flows endpoint).
   * Offered only to a modern client that presents the owner bearer, because a
   * task belongs to that owner. Proxy and private worker profiles stay
   * synchronous. On by default; FLUJO_MCP_TASKS_SERVER=false turns it off.
   */
  get ENABLE_MCP_TASKS_SERVER(): boolean {
    return process.env.FLUJO_MCP_TASKS_SERVER?.trim().toLowerCase() !== 'false';
  },

  /** Enable automatic expiry of untouched memory candidates (issue #452). */
  ENABLE_MEMORY_CANDIDATE_EXPIRY: true,

  /** Enable automatic promotion of corroborated memory candidates to active status (issue #452). Default OFF for safety. */
  ENABLE_MEMORY_AUTO_PROMOTION: false,

  /** Enable conflict detection and linking of contradictory memory facts (issue #452). */
  ENABLE_MEMORY_CONFLICT_SURFACING: true,

  /**
   * Irreversibly delete verified dead Persona lease-history records (issue #478).
   * Independent from Persona history cleanup (#481) and deliberately OFF by default.
   */
  ENABLE_PERSONA_LEASE_HISTORY_PRUNING: false,

  /**
   * Record baseline/observed outcome metrics for activated Behavior proposals
   * (issue #455). Recording only; the detector still computes and stores a
   * verdict so a regression can be observed in shadow mode before anyone
   * allows FLUJO to act on it.
   */
  ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS: false,

  /**
   * Permit the outcome detector to automatically revert a regressed proposal
   * through the existing compare-and-swap rollback (issue #455). Deliberately
   * independent of recording, and additionally gated on Persona autonomy.
   */
  ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK: false,
};

/**
 * Whether Behavior maintenance diagnosis may take actionable work.
 *
 * Admission is intentionally excluded so it can continue collecting shadow
 * evidence. Values are read on every call so rollout changes take effect
 * without caching stale readiness.
 */
export function isPersonaBehaviorMaintenanceDiagnosisReady(): boolean {
  return FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS
    && FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS
    && FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK;
}
