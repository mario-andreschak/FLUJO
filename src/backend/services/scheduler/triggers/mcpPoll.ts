import { Cron } from 'croner';
import {
  McpPollTriggerConfig,
  PlannedExecutionState,
} from '@/shared/types/plannedExecution';
import { intervalMsToCron } from '@/utils/shared/cron';
import { createLogger } from '@/utils/logger';
import { ArmedTrigger } from './types';
import { evaluateNewItems, evaluateOnChange, PollEvaluation } from './pollEvaluators';

const log = createLogger('backend/services/scheduler/triggers/mcpPoll');

/** Cap the error backoff at skipping this many checks. */
const MAX_BACKOFF_SKIPS = 8;

/**
 * Dependencies are injected so the trigger is testable without the MCP layer
 * and so the llm-gate evaluator (a model call) can be plugged in by the
 * service without this module depending on the model stack.
 */
export interface McpPollDeps {
  callTool: (
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  loadState: () => Promise<PlannedExecutionState>;
  saveState: (patch: Partial<PlannedExecutionState>) => Promise<void>;
  onFire: (payload: { summary: string; context: unknown }) => void;
  onError: (message: string) => void;
  /**
   * Called after every successful poll+evaluation (fired or not), so a stale
   * trigger error (e.g. the startup race while servers are still connecting)
   * clears as soon as polling recovers — not only on the next fire.
   */
  onSuccess?: () => void;
  /** "AI decides" evaluator — handles both llm-gate and flow-gate modes. */
  evaluateAiGate?: (
    result: unknown,
    config: Extract<McpPollTriggerConfig['evaluate'], { mode: 'llm-gate' } | { mode: 'flow-gate' }>,
    state: PlannedExecutionState
  ) => Promise<PollEvaluation>;
}

/**
 * Arm an MCP polling trigger: on a cron schedule, call the configured tool
 * and evaluate the result (on-change hash / new-items dedup / AI gate). The
 * first successful poll primes the baseline without firing; an immediate
 * check runs at arm time. Failed polls back off exponentially (skip 1, 2, 4 …
 * up to 8 checks) and surface as trigger errors without producing run
 * records. Configs saved before the cron switch derive a pattern from their
 * legacy intervalMs.
 */
export function armMcpPoll(config: McpPollTriggerConfig, deps: McpPollDeps): ArmedTrigger {
  const cron = config.cron || intervalMsToCron(config.intervalMs);
  let busy = false;
  let disposed = false;
  let consecutiveFailures = 0;
  let skipsRemaining = 0;

  const tick = async (): Promise<void> => {
    if (disposed || busy) {
      return;
    }
    if (skipsRemaining > 0) {
      skipsRemaining--;
      return;
    }
    busy = true;
    try {
      const response = await deps.callTool(config.serverName, config.toolName, config.args);
      if (!response.success) {
        throw new Error(response.error || 'Tool call failed');
      }
      consecutiveFailures = 0;

      const state = await deps.loadState();
      let evaluation: PollEvaluation;
      const evaluate = config.evaluate;
      if (evaluate.mode === 'on-change') {
        evaluation = evaluateOnChange(response.data, state);
      } else if (evaluate.mode === 'new-items') {
        evaluation = evaluateNewItems(response.data, evaluate.itemsPath, evaluate.idField, state);
      } else if (deps.evaluateAiGate) {
        evaluation = await deps.evaluateAiGate(response.data, evaluate, state);
      } else {
        evaluation = {
          fire: false,
          newState: {},
          error: 'The "AI decides" condition is not available yet',
        };
      }

      if (disposed) {
        return; // disarmed while polling — drop the outcome
      }
      if (Object.keys(evaluation.newState).length > 0) {
        await deps.saveState(evaluation.newState);
      }
      if (evaluation.error) {
        deps.onError(evaluation.error);
      } else if (!evaluation.fire) {
        deps.onSuccess?.();
      } else {
        deps.onFire({
          summary: `Watched tool: ${evaluation.summary ?? 'condition met'}`,
          context: {
            server: config.serverName,
            tool: config.toolName,
            ...(typeof evaluation.context === 'object' && evaluation.context !== null
              ? (evaluation.context as Record<string, unknown>)
              : { result: evaluation.context }),
          },
        });
      }
    } catch (error) {
      consecutiveFailures++;
      skipsRemaining = Math.min(2 ** (consecutiveFailures - 1), MAX_BACKOFF_SKIPS);
      const message = error instanceof Error ? error.message : String(error);
      log.warn(
        `Poll failed for ${config.serverName}/${config.toolName} (backing off ${skipsRemaining} check(s)): ${message}`
      );
      deps.onError(message);
    } finally {
      busy = false;
    }
  };

  const job = new Cron(cron, { timezone: config.timezone, unref: true }, () => void tick());
  // Prime immediately so a fresh trigger has its baseline before the first tick.
  void tick();

  return {
    dispose: () => {
      disposed = true;
      job.stop();
    },
    nextRun: () => job.nextRun()?.toISOString() ?? null,
  };
}
