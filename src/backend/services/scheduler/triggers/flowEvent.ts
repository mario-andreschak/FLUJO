import { FlowEventTriggerConfig } from '@/shared/types/plannedExecution';
import { createLogger } from '@/utils/logger';
import { ArmedTrigger } from './types';
import { getFlowRunEventBus, FlowRunEvent } from '../flowRunEventBus';

const log = createLogger('backend/services/scheduler/triggers/flowEvent');

/** Default event-chain depth cap when the config doesn't set one. */
export const DEFAULT_MAX_CHAIN_DEPTH = 5;
/** Cap the upstream output scanned by `outputMatch` to bound regex work (ReDoS). */
const MAX_MATCH_CHARS = 16_384;
/** Cap the upstream output carried into the fired run's context/prompt. */
const MAX_CONTEXT_CHARS = 8_192;

export interface FlowEventDeps {
  /**
   * Dispatch the run. `chainDepth` is the depth of the NEW run (upstream + 1);
   * the scheduler stamps it onto the next FlowRunEvent so a runaway chain trips
   * `maxChainDepth`. Fire-and-forget — the bus listener stays synchronous.
   */
  onFire: (payload: { summary: string; context: unknown; chainDepth: number }) => void;
  /**
   * Record a `skipped` run instead of firing (loop safety: the event-chain
   * depth reached `maxChainDepth`). Preserves the audit trail.
   */
  onSkip: (reason: string) => void;
  /** Surface a trigger-level problem (e.g. a bad regex) to the UI. */
  onError: (message: string) => void;
}

/**
 * Arm a flow-event trigger (issue #116): subscribe to the process-global
 * FlowRunEvent bus and fire the bound flow when another flow reaches a matching
 * terminal state. Purely in-process (the source run just finished), so there is
 * no cron/timer — `nextRun()` is always null. Loop safety comes from the
 * event-chain depth cap plus an optional `minIntervalMs` cooldown; the
 * scheduler's overlap-skip covers same-execution self-retrigger.
 */
export function armFlowEvent(config: FlowEventTriggerConfig, deps: FlowEventDeps): ArmedTrigger {
  const maxChainDepth = config.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
  // In-memory cooldown clock: a restart clears it, which is the safe direction
  // (at worst one extra fire right after boot, never a suppressed real event).
  let lastFireMs = 0;

  // Precompile the outputMatch regex once; an invalid pattern is a config error
  // surfaced immediately. Validation rejects it at save time, so this is a
  // defensive fail-closed: a trigger whose filter can't compile never fires
  // (rather than silently ignoring the filter and firing on everything).
  let outputRegex: RegExp | null = null;
  let outputMatchBroken = false;
  if (config.outputMatch?.regex) {
    try {
      outputRegex = new RegExp(config.outputMatch.regex);
    } catch (error) {
      outputMatchBroken = true;
      const message = `Invalid output-match regex: ${error instanceof Error ? error.message : String(error)}`;
      log.warn(message);
      deps.onError(message);
    }
  }

  const matchesSource = (event: FlowRunEvent): boolean => {
    const src = config.source;
    if (src.executionId) {
      return event.executionId === src.executionId;
    }
    if (src.flowId) {
      return event.flowId === src.flowId;
    }
    if (src.flowName) {
      return event.flowName === src.flowName;
    }
    return false; // no source set — matches nothing (validation blocks this)
  };

  const matchesOutput = (text: string | undefined): boolean => {
    if (!config.outputMatch) {
      return true;
    }
    if (outputMatchBroken) {
      return false; // fail-closed: an uncompilable filter matches nothing
    }
    const haystack = (text ?? '').slice(0, MAX_MATCH_CHARS);
    if (config.outputMatch.contains && !haystack.includes(config.outputMatch.contains)) {
      return false;
    }
    if (outputRegex && !outputRegex.test(haystack)) {
      return false;
    }
    return true;
  };

  const unsubscribe = getFlowRunEventBus().subscribe((event) => {
    try {
      if (!matchesSource(event)) {
        return;
      }
      if (!config.on.includes(event.status)) {
        return;
      }
      if (!matchesOutput(event.outputText)) {
        return;
      }

      // Loop safety: refuse to extend a chain that's already at the limit.
      if (event.chainDepth >= maxChainDepth) {
        const reason = `Flow-event chain reached the depth limit (${maxChainDepth}); not firing again`;
        log.info(reason);
        deps.onSkip(reason);
        return;
      }

      // Cooldown clamp.
      const now = Date.now();
      if (config.minIntervalMs && now - lastFireMs < config.minIntervalMs) {
        log.debug(
          `Flow-event cooldown active (${config.minIntervalMs}ms); ignoring ${event.flowId} ${event.status}`
        );
        return;
      }
      lastFireMs = now;

      const label = event.flowName ?? event.flowId;
      deps.onFire({
        summary: `Flow "${label}" ${event.status}`,
        context: {
          flowId: event.flowId,
          flowName: event.flowName,
          executionId: event.executionId,
          runId: event.runId,
          conversationId: event.conversationId,
          status: event.status,
          firedBy: event.firedBy,
          outputText:
            event.outputText && event.outputText.length > MAX_CONTEXT_CHARS
              ? `${event.outputText.slice(0, MAX_CONTEXT_CHARS)}… (truncated)`
              : event.outputText,
          error: event.error,
        },
        chainDepth: event.chainDepth + 1,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Flow-event handling failed: ${message}`);
      deps.onError(message);
    }
  });

  return {
    dispose: () => unsubscribe(),
    // In-process, event-driven — there is no next scheduled time.
    nextRun: () => null,
  };
}
