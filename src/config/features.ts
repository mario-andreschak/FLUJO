/**
 * Fixed application constants. FLUJO has no feature switches (#1449): a
 * feature is on, falls back by itself when it cannot work, or is removed.
 * `__tests__/architecture/noFeatureSwitches.test.ts` keeps this list closed.
 */

export interface PersonaRuntimeEventLogConfig {
  maxSegmentBytes: number;
  maxSegmentEvents: number;
  /** Closed segments older than this are removed once Persona cleanup is active (#481). */
  retentionDays: number;
  /** Newest closed segments protected from age-based retention. */
  maxClosedSegments: number;
}

export const PERSONA_RUNTIME_EVENT_LOG_DEFAULT_CONFIG:
  PersonaRuntimeEventLogConfig = Object.freeze({
    maxSegmentBytes: 8 * 1024 * 1024,
    maxSegmentEvents: 20_000,
    retentionDays: 90,
    maxClosedSegments: 30,
  });

export const FEATURES = {
  /**
   * Application log level: -1 VERBOSE, 0 DEBUG, 1 INFO, 2 WARN, 3 ERROR.
   * Only messages at or above this level are written.
   */
  LOG_LEVEL: 3,
};
