import type { BehaviorOutcomePolicy } from '@/shared/types/enduringAgent';

/**
 * Outcome-detector thresholds (issue #455).
 *
 * These mirror the statistics comparison precedent
 * (`STATISTICS_MIN_COMPARISON_SAMPLES`) so a Behavior decision is never taken
 * from a handful of noisy runs. A frozen copy of the effective policy is stored
 * on every metric, so a later threshold change cannot silently re-interpret an
 * already recorded verdict.
 */
export const BEHAVIOR_OUTCOME_MIN_SAMPLES = 10;
/** Success-rate drop (absolute, 0..1) that counts as a regression. */
export const BEHAVIOR_OUTCOME_REGRESSION_DELTA = 0.15;
/** Success-rate gain (absolute, 0..1) that counts as an improvement. */
export const BEHAVIOR_OUTCOME_IMPROVEMENT_DELTA = 0.05;
export const BEHAVIOR_OUTCOME_BASELINE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
export const BEHAVIOR_OUTCOME_OBSERVATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const BEHAVIOR_OUTCOME_DETECTOR_VERSION = 'behavior-outcome-v1';

export const BEHAVIOR_OUTCOME_POLICY: BehaviorOutcomePolicy = Object.freeze({
  minSamples: BEHAVIOR_OUTCOME_MIN_SAMPLES,
  regressionDelta: BEHAVIOR_OUTCOME_REGRESSION_DELTA,
  improvementDelta: BEHAVIOR_OUTCOME_IMPROVEMENT_DELTA,
  baselineLookbackMs: BEHAVIOR_OUTCOME_BASELINE_LOOKBACK_MS,
  observationWindowMs: BEHAVIOR_OUTCOME_OBSERVATION_WINDOW_MS,
});

/** Actor recorded on every automatic revert, distinct from any human actor. */
export const BEHAVIOR_OUTCOME_DETECTOR_ACTOR = 'behavior-outcome-detector';
