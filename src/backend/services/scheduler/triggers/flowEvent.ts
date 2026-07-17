import { FlowEventTriggerConfig } from '@/shared/types/plannedExecution';
import { createLogger } from '@/utils/logger';
import { ArmedTrigger } from './types';
import { getFlowRunEventBus, FlowRunEvent, isFlowSignalEvent } from '../flowRunEventBus';

const log = createLogger('backend/services/scheduler/triggers/flowEvent');

/** Default event-chain depth cap when the config doesn't set one. */
export const DEFAULT_MAX_CHAIN_DEPTH = 5;
/** Cap the upstream output scanned by `outputMatch` to bound regex work (ReDoS). */
const MAX_MATCH_CHARS = 16_384;
/** Cap the upstream output/payload carried into the fired run's context/prompt. */
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

/** Truncate text carried into the fired run's prompt/context. */
function clampContext(text: string | undefined): string | undefined {
  if (text && text.length > MAX_CONTEXT_CHARS) {
    return `${text.slice(0, MAX_CONTEXT_CHARS)}… (truncated)`;
  }
  return text;
}

/**
 * Arm a flow-event trigger (issue #116, extended by #117): subscribe to the
 * process-global bus and fire the bound flow when a matching event arrives.
 * Two source kinds are supported and are mutually exclusive:
 *  - a flow / planned-execution source reacts to another flow reaching a
 *    terminal state (completed/error) — the #116 behavior;
 *  - a `topic` source reacts to a `signal` node emission with that topic
 *    (issue #117) — a deterministic, mid-run event.
 * Purely in-process (the source run is up), so there is no cron/timer —
 * `nextRun()` is always null. Loop safety comes from the shared event-chain
 * depth cap plus an optional `minIntervalMs` cooldown; the scheduler's
 * overlap-skip covers same-execution self-retrigger.
 */
export function armFlowEvent(config: FlowEventTriggerConfig, deps: FlowEventDeps): ArmedTrigger {
  const maxChainDepth = config.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
  const topic = typeof config.source.topic === 'string' ? config.source.topic.trim() : '';
  const isTopicTrigger = topic.length > 0;
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

  const matchesRunSource = (event: FlowRunEvent): boolean => {
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

  // Applies to a run's output text OR a signal's payload — both are free text.
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

  // Shared loop-safety gate: refuse to extend a chain at the cap, clamp the
  // cooldown, then fire at chainDepth + 1 (the new run is one hop deeper).
  const attemptFire = (sourceDepth: number, summary: string, context: unknown): void => {
    if (sourceDepth >= maxChainDepth) {
      const reason = `Flow-event chain reached the depth limit (${maxChainDepth}); not firing again`;
      log.info(reason);
      deps.onSkip(reason);
      return;
    }
    const now = Date.now();
    if (config.minIntervalMs && now - lastFireMs < config.minIntervalMs) {
      log.debug(`Flow-event cooldown active (${config.minIntervalMs}ms); ignoring event`);
      return;
    }
    lastFireMs = now;
    deps.onFire({ summary, context, chainDepth: sourceDepth + 1 });
  };

  const unsubscribe = getFlowRunEventBus().subscribe((event) => {
    try {
      if (isTopicTrigger) {
        // A topic trigger reacts ONLY to signal-node emissions (issue #117);
        // terminal-run events are irrelevant to it.
        if (!isFlowSignalEvent(event)) {
          return;
        }
        if (event.topic !== topic) {
          return;
        }
        if (!matchesOutput(event.payload)) {
          return;
        }
        attemptFire(event.chainDepth, `Signal "${event.topic}"`, {
          topic: event.topic,
          payload: clampContext(event.payload),
          emitterFlowId: event.emitterFlowId,
          flowName: event.flowName,
          runId: event.runId,
          conversationId: event.conversationId,
          firedBy: event.firedBy,
        });
        return;
      }

      // A flow/execution trigger reacts ONLY to terminal-run events — a signal
      // emission from the watched flow must not masquerade as a completion.
      if (isFlowSignalEvent(event)) {
        return;
      }
      if (!matchesRunSource(event)) {
        return;
      }
      if (!event.status || !(config.on ?? []).includes(event.status)) {
        return;
      }
      if (!matchesOutput(event.outputText)) {
        return;
      }
      const label = event.flowName ?? event.flowId;
      attemptFire(event.chainDepth, `Flow "${label}" ${event.status}`, {
        flowId: event.flowId,
        flowName: event.flowName,
        executionId: event.executionId,
        runId: event.runId,
        conversationId: event.conversationId,
        status: event.status,
        firedBy: event.firedBy,
        outputText: clampContext(event.outputText),
        error: event.error,
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
