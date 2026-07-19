// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import {
  OverlapStrategy,
  PlannedExecution,
  PlannedExecutionsFile,
  PlannedExecutionStatus,
  RunRecord,
  TriggerFirePayload,
} from '@/shared/types/plannedExecution';
import { createLogger } from '@/utils/logger';
import { isEncryptionLocked } from '@/utils/encryption/secure';
import { ArmedTrigger } from './triggers/types';
import { armSchedule, isCatchUpDue, validateSchedule } from './triggers/schedule';
import { armFileWatch } from './triggers/fileWatch';
import { armMcpPoll } from './triggers/mcpPoll';
import { intervalMsToCron } from '@/utils/shared/cron';
import { armUrlWatch } from './triggers/urlWatch';
import { armFlowEvent } from './triggers/flowEvent';
import { getFlowRunEventBus, FlowRunFiredBy } from './flowRunEventBus';
import { appendRunRecord, deleteRunHistory, loadLastRunRecord, loadRunRecords } from './runHistory';
import { deleteExecutionState, loadExecutionState, saveExecutionState } from './state';
import type { FlowRunResult } from '@/backend/execution/flow/runFlow';

const log = createLogger('backend/services/scheduler/index');

/** Final assistant output is truncated to this many chars in run history. */
const MAX_STORED_OUTPUT_CHARS = 4096;

const EMPTY_FILE: PlannedExecutionsFile = { version: 1, paused: false, executions: [] };

export interface PlannedExecutionListEntry {
  execution: PlannedExecution;
  status: PlannedExecutionStatus;
  lastRun: RunRecord | null;
}

/** A fire deferred by the 'queue' overlap strategy (issue #121). */
interface QueuedFire {
  execution: PlannedExecution;
  payload: TriggerFirePayload;
  runId: string;
  /** Resolved with the RunRecord once the queued fire actually runs. */
  resolve: (record: RunRecord) => void;
}

/**
 * SchedulerService — Planned Executions (#10).
 *
 * Owns the persisted trigger configs (db/planned_executions.json), arms one
 * trigger per enabled execution, and runs the bound flow headlessly via
 * runFlow when a trigger fires. Runs are ephemeral by default (never touch the
 * chat sidebar); every outcome is appended to the execution's run history.
 *
 * Booted once per process from backend/init.ts. The INSTANCE lives on
 * `global.__flujo_scheduler` (same reasoning as the MCP service's global maps:
 * in production `next start`, the module instance that runs startup is not the
 * one serving API routes, and armed croner timers/watchers must live exactly
 * once).
 */
export class SchedulerService {
  /** Armed trigger per enabled execution id. */
  private armed = new Map<string, ArmedTrigger>();
  /**
   * In-flight runs per execution id, mapped runId → ISO start time. A nested
   * map (rather than a single start time) lets the 'parallel' overlap strategy
   * (issue #121) hold MORE THAN ONE concurrent run per execution while still
   * surfacing a live "Running…" state + earliest-start elapsed timer via
   * getStatus() — issue #50.
   */
  private running = new Map<string, Map<string, string>>();
  /**
   * Fires deferred by the 'queue' overlap strategy (issue #121), FIFO per
   * execution id. Drained one at a time as each run finishes; bounded by
   * MAX_QUEUE_DEPTH so a webhook/poll burst can't grow it without limit.
   */
  private queued = new Map<string, QueuedFire[]>();
  /** Hard cap on the per-execution overlap queue depth (issue #121). */
  private static readonly MAX_QUEUE_DEPTH = 50;
  /**
   * Execution id currently holding the scheduler-global exclusive lock
   * (issue #171), or null when no exclusive execution is active. While set,
   * only fires for THIS id (its own self-overlap) may start; every other
   * execution's fire is gated per `nonExclusiveBehavior`.
   */
  private exclusiveHolder: string | null = null;
  /** nonExclusiveBehavior of the current exclusive holder (issue #171). */
  private exclusiveHolderBehavior: 'queue' | 'skip' | 'error' = 'queue';
  /**
   * Exclusive executions waiting for the scheduler to drain to idle so they
   * can acquire the lock (issue #171). FIFO; bounded by MAX_QUEUE_DEPTH.
   */
  private exclusiveWaiting: QueuedFire[] = [];
  /**
   * Non-exclusive fires deferred because an exclusive execution holds/awaits
   * the lock with nonExclusiveBehavior 'queue' (issue #171). FIFO; bounded.
   */
  private blockedByExclusive: QueuedFire[] = [];
  /** Most recent trigger-level error (watcher/poll failures), for the UI. */
  private lastTriggerErrors = new Map<string, string>();
  /** Serializes reconcile/arm mutations so concurrent API calls can't interleave. */
  private reconcileChain: Promise<unknown> = Promise.resolve();
  /** Pause state as of the last reconcile (for synchronous status reads). */
  private pausedCache = false;
  private started = false;

  // --- lifecycle -----------------------------------------------------------

  /** Idempotent process-startup entry point (called from backend/init.ts). */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    log.info('Starting scheduler');
    await this.reconcile();
  }

  /**
   * Dispose every armed trigger and re-arm from the persisted configs. The
   * single write-path for arming state; all mutations funnel through here.
   */
  reconcile(): Promise<void> {
    const run = this.reconcileChain
      .catch(() => { /* prior reconcile's error surfaced to its own caller */ })
      .then(() => this.doReconcile());
    this.reconcileChain = run;
    return run;
  }

  private async doReconcile(): Promise<void> {
    for (const [id, trigger] of this.armed) {
      try {
        trigger.dispose();
      } catch (error) {
        log.warn(`Failed to dispose trigger for ${id}:`, error);
      }
    }
    this.armed.clear();

    const file = await this.loadFile();
    this.pausedCache = file.paused;
    if (file.paused) {
      log.info('Scheduler is paused — nothing armed');
      return;
    }
    for (const execution of file.executions) {
      if (!execution.enabled) {
        continue;
      }
      try {
        await this.armExecution(execution);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastTriggerErrors.set(execution.id, message);
        log.error(`Failed to arm "${execution.name}" (${execution.id}):`, error);
      }
    }
    log.info(`Scheduler armed ${this.armed.size} execution(s)`);
  }

  private async armExecution(execution: PlannedExecution): Promise<void> {
    const trigger = execution.trigger;
    switch (trigger.type) {
      case 'schedule': {
        const state = await loadExecutionState(execution.id);
        if (!state.lastScheduledFireAt) {
          // Prime the catch-up baseline so a brand-new schedule never
          // "catches up" a run that was simply never due.
          await saveExecutionState(execution.id, {
            ...state,
            lastScheduledFireAt: new Date().toISOString(),
          });
        } else if (trigger.catchUp && isCatchUpDue(trigger, state.lastScheduledFireAt)) {
          // One catch-up run, never a replay of every missed occurrence.
          // Stamp BEFORE firing so a concurrent reconcile can't double-fire.
          await saveExecutionState(execution.id, {
            ...state,
            lastScheduledFireAt: new Date().toISOString(),
          });
          log.info(`Catch-up run for "${execution.name}" (missed while closed)`);
          void this.fire(execution, {
            kind: 'schedule-catchup',
            summary: 'Schedule (missed while FLUJO was closed — ran once at startup)',
          });
        }
        this.armed.set(
          execution.id,
          armSchedule(trigger, () => {
            void (async () => {
              const current = await loadExecutionState(execution.id);
              await saveExecutionState(execution.id, {
                ...current,
                lastScheduledFireAt: new Date().toISOString(),
              });
              await this.fire(execution, { kind: 'schedule', summary: 'Schedule' });
            })().catch(error =>
              log.error(`Scheduled fire failed for ${execution.id}:`, error)
            );
          })
        );
        break;
      }
      case 'webhook':
        // Nothing to arm — the /api/webhooks/[id] route fires directly.
        break;
      case 'file-watch': {
        this.armed.set(
          execution.id,
          armFileWatch(
            trigger,
            ({ events }) => {
              this.lastTriggerErrors.delete(execution.id);
              void this.fire(execution, {
                kind: 'file',
                summary:
                  events.length === 1
                    ? `File ${events[0].event === 'unlink' ? 'deleted' : events[0].event === 'add' ? 'added' : 'changed'}`
                    : `${events.length} file changes`,
                context: { watchedPath: trigger.path, events },
              });
            },
            message => this.lastTriggerErrors.set(execution.id, message)
          )
        );
        break;
      }
      case 'mcp-poll': {
        // Arm-time pre-check (issue #54): polling a disabled server can never succeed,
        // so surface a precise trigger error immediately instead of letting the first
        // tick fail. The trigger is still armed — once the server is re-enabled the
        // next successful tick clears the error on its own (onSuccess/onFire below).
        void import('@/backend/services/mcp')
          .then(async ({ mcpService }) => {
            if (await mcpService.isServerDisabled(trigger.serverName)) {
              this.lastTriggerErrors.set(
                execution.id,
                `MCP server '${trigger.serverName}' is disabled — enable it on the MCP page or change the trigger`
              );
            }
          })
          .catch(error =>
            log.warn(`Arm-time disabled-server check failed for ${execution.id}:`, error)
          );
        this.armed.set(
          execution.id,
          armMcpPoll(trigger, {
            callTool: async (serverName, toolName, args) => {
              // Lazy import: don't pull the MCP stack into scheduler tests.
              const { mcpService } = await import('@/backend/services/mcp');
              const response = await mcpService.callTool(serverName, toolName, args);
              return {
                success: response.success === true,
                data: response.data,
                error: typeof response.error === 'string' ? response.error : undefined,
              };
            },
            loadState: () => loadExecutionState(execution.id),
            saveState: async patch => {
              const current = await loadExecutionState(execution.id);
              await saveExecutionState(execution.id, { ...current, ...patch });
            },
            // Await the run and report its outcome so the poll can advance its
            // change baseline only after a successful run (commit-after-success,
            // issue #75). Keeping the trigger busy for the run's duration also
            // naturally prevents an overlapping poll of the same trigger.
            onFire: async ({ summary, context }) => {
              this.lastTriggerErrors.delete(execution.id);
              const record = await this.fire(execution, { kind: 'mcp-poll', summary, context });
              return { status: record.status };
            },
            onError: message => this.lastTriggerErrors.set(execution.id, message),
            onSuccess: () => this.lastTriggerErrors.delete(execution.id),
            evaluateAiGate: async (result, gateConfig, state) => {
              // Lazy import: the gate pulls in the model/flow stack.
              const { evaluateAiGate } = await import('./triggers/llmGate');
              return evaluateAiGate(result, gateConfig, state);
            },
          })
        );
        break;
      }
      case 'url-watch': {
        this.armed.set(
          execution.id,
          armUrlWatch(trigger, {
            loadState: () => loadExecutionState(execution.id),
            saveState: async patch => {
              const current = await loadExecutionState(execution.id);
              await saveExecutionState(execution.id, { ...current, ...patch });
            },
            // Await + report outcome so the baseline hash advances only after a
            // successful run (commit-after-success, issue #75).
            onFire: async ({ summary, context }) => {
              this.lastTriggerErrors.delete(execution.id);
              const record = await this.fire(execution, { kind: 'url-watch', summary, context });
              return { status: record.status };
            },
            onError: message => this.lastTriggerErrors.set(execution.id, message),
            onSuccess: () => this.lastTriggerErrors.delete(execution.id),
          })
        );
        break;
      }
      case 'flow-event': {
        this.armed.set(
          execution.id,
          armFlowEvent(trigger, {
            onFire: ({ summary, context, chainDepth }) => {
              this.lastTriggerErrors.delete(execution.id);
              // Fire-and-forget: the bus listener is synchronous. Any run
              // outcome is recorded by fire() as a RunRecord.
              void this.fire(execution, { kind: 'flow-event', summary, context, chainDepth }).catch(
                error => log.error(`Flow-event fire failed for ${execution.id}:`, error)
              );
            },
            // Loop safety: record the depth-limit skip as a run so it's auditable.
            onSkip: reason => {
              const at = new Date().toISOString();
              void appendRunRecord(execution.id, {
                runId: uuidv4(),
                conversationId: '',
                firedAt: at,
                finishedAt: at,
                status: 'skipped',
                triggerSummary: 'Flow event',
                error: reason,
              }).catch(error =>
                log.warn(`Failed to record flow-event skip for ${execution.id}:`, error)
              );
            },
            onError: message => this.lastTriggerErrors.set(execution.id, message),
          })
        );
        break;
      }
      default:
        log.warn(
          `Trigger type "${(trigger as { type: string }).type}" is not implemented — "${execution.name}" not armed`
        );
    }
  }

  // --- persistence ---------------------------------------------------------

  private async loadFile(): Promise<PlannedExecutionsFile> {
    const file = await loadItem<PlannedExecutionsFile>(
      StorageKey.PLANNED_EXECUTIONS,
      EMPTY_FILE
    );
    // Defensive defaults so a hand-edited file can't crash the scheduler.
    return {
      version: 1,
      paused: file.paused === true,
      executions: Array.isArray(file.executions) ? file.executions : [],
    };
  }

  private async saveFile(file: PlannedExecutionsFile): Promise<void> {
    await saveItem(StorageKey.PLANNED_EXECUTIONS, file);
  }

  // --- CRUD ----------------------------------------------------------------

  async isPaused(): Promise<boolean> {
    return (await this.loadFile()).paused;
  }

  async setPaused(paused: boolean): Promise<void> {
    const file = await this.loadFile();
    await this.saveFile({ ...file, paused });
    await this.reconcile();
    // Pausing must stop deferred fires too, not just disarm triggers (issue
    // #122): a queued fire would otherwise run a flow while globally paused.
    // Cancel every queued fire (storage still exists, so audit the skip).
    if (paused) {
      for (const id of [...this.queued.keys()]) {
        await this.cancelQueued(id, 'scheduler paused', true);
      }
      // Exclusive waiters and exclusive-blocked fires must not run while paused
      // either (issue #171); cancel them so their awaiters never hang.
      await this.cancelAllExclusiveWaiting('scheduler paused', true);
    }
  }

  async list(): Promise<PlannedExecutionListEntry[]> {
    const file = await this.loadFile();
    return Promise.all(
      file.executions.map(async execution => ({
        execution,
        status: this.getStatus(execution),
        lastRun: await loadLastRunRecord(execution.id),
      }))
    );
  }

  async get(id: string): Promise<PlannedExecution | null> {
    const file = await this.loadFile();
    return file.executions.find(e => e.id === id) ?? null;
  }

  /**
   * Create a new execution. Fills timestamps/webhook-token server-side. The
   * client MAY supply the id — that's what lets the editor show the webhook URL
   * before the first save, AND what lets a package applier install a planned
   * execution under a deterministic, human-readable id (e.g. `pkg--my-flow`) so
   * upgrades/removals are idempotent without a name→id bookkeeping table
   * (issue #113, mirroring POST /api/flow). The charset is deliberately
   * restricted to a safe identifier: it excludes path separators, `..`,
   * whitespace and control chars, so a caller id can never escape the per-run
   * storage key (planned-execution-state/<id>.json, run history) it derives.
   */
  async create(
    input: Omit<PlannedExecution, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
  ): Promise<{ execution?: PlannedExecution; error?: string; conflict?: boolean }> {
    const error = this.validateInput(input);
    if (error) {
      return { error };
    }
    if (input.id !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(input.id)) {
      return {
        error:
          'The id must be 1-128 characters of letters, digits, dot, underscore, colon or hyphen',
      };
    }
    // The charset above permits `.`, so a bare `.`/`..` would still pass and could
    // be used to walk out of the per-run storage folder (planned-execution-state/<id>.json).
    // Reject the dot-only path segments explicitly before any storage key is built.
    if (input.id === '.' || input.id === '..') {
      return { error: 'The id must be a safe identifier, not "." or ".."' };
    }
    const now = new Date().toISOString();
    const execution: PlannedExecution = {
      ...input,
      trigger: this.normalizeTrigger(input.trigger),
      id: input.id ?? uuidv4(),
      createdAt: now,
      updatedAt: now,
    };
    const file = await this.loadFile();
    if (file.executions.some(e => e.id === execution.id)) {
      return {
        error: `A planned execution with id "${execution.id}" already exists`,
        conflict: true,
      };
    }
    await this.saveFile({ ...file, executions: [...file.executions, execution] });
    await this.reconcile();
    return { execution };
  }

  async update(
    id: string,
    patch: Partial<Omit<PlannedExecution, 'id' | 'createdAt' | 'updatedAt'>>
  ): Promise<{ execution?: PlannedExecution; error?: string }> {
    const file = await this.loadFile();
    const index = file.executions.findIndex(e => e.id === id);
    if (index < 0) {
      return { error: `No planned execution with id "${id}"` };
    }
    const merged: PlannedExecution = {
      ...file.executions[index],
      ...patch,
      ...(patch.trigger ? { trigger: this.normalizeTrigger(patch.trigger) } : {}),
      id,
      createdAt: file.executions[index].createdAt,
      updatedAt: new Date().toISOString(),
    };
    const error = this.validateInput(merged);
    if (error) {
      return { error };
    }
    const executions = [...file.executions];
    executions[index] = merged;
    await this.saveFile({ ...file, executions });
    await this.reconcile();
    // A queued fire captured the PRE-update snapshot (stale flowId/prompt/
    // overlapStrategy) at enqueue time (issue #122). Cancel those stale fires
    // rather than silently running the old config; storage still exists so the
    // skip is audited. Fresh fires re-enqueue against the updated config.
    await this.cancelQueued(id, 'execution updated', true);
    // Same staleness reasoning for the exclusive-mode global queues (issue #171).
    await this.cancelExclusiveWaiting(id, 'execution updated', true);
    return { execution: merged };
  }

  async delete(id: string): Promise<{ success: boolean; error?: string }> {
    const file = await this.loadFile();
    if (!file.executions.some(e => e.id === id)) {
      return { success: false, error: `No planned execution with id "${id}"` };
    }
    await this.saveFile({
      ...file,
      executions: file.executions.filter(e => e.id !== id),
    });
    await this.reconcile();
    this.lastTriggerErrors.delete(id);
    // Cancel deferred fires BEFORE erasing history (issue #122). appendAudit is
    // false so appendRunRecord can't recreate planned-execution-runs/<id>.json
    // — the reported resurrection bug.
    await this.cancelQueued(id, 'execution deleted', false);
    // Drop any exclusive-mode waiters for this id before erasing history so a
    // drain can't resurrect storage (issue #171, mirrors cancelQueued).
    await this.cancelExclusiveWaiting(id, 'execution deleted', false);
    await deleteRunHistory(id);
    await deleteExecutionState(id);
    return { success: true };
  }

  /**
   * Fill server-side trigger fields: an empty webhook token generates one;
   * legacy interval-based poll configs gain an equivalent cron on save.
   */
  private normalizeTrigger(trigger: PlannedExecution['trigger']): PlannedExecution['trigger'] {
    if (trigger?.type === 'webhook' && !trigger.token) {
      return { ...trigger, token: uuidv4() };
    }
    if (trigger?.type === 'mcp-poll' && !trigger.cron) {
      return { ...trigger, cron: intervalMsToCron(trigger.intervalMs) };
    }
    return trigger;
  }

  private validateInput(
    input: Omit<PlannedExecution, 'id' | 'createdAt' | 'updatedAt'>
  ): string | null {
    if (!input.name?.trim()) {
      return 'A name is required';
    }
    if (!input.flowId) {
      return 'A flow is required';
    }
    if (typeof input.prompt !== 'string') {
      return 'A prompt is required (may be empty)';
    }
    if (
      input.overlapStrategy !== undefined &&
      !['skip', 'queue', 'parallel', 'error'].includes(input.overlapStrategy)
    ) {
      return 'Overlap strategy must be one of: skip, queue, parallel, error';
    }
    if (input.exclusive !== undefined && typeof input.exclusive !== 'boolean') {
      return 'Exclusive must be true or false';
    }
    if (
      input.nonExclusiveBehavior !== undefined &&
      !['queue', 'skip', 'error'].includes(input.nonExclusiveBehavior)
    ) {
      return 'When exclusive is on, other triggers must be one of: queue, skip, error';
    }
    const trigger = input.trigger;
    if (!trigger || typeof trigger !== 'object') {
      return 'A trigger is required';
    }
    switch (trigger.type) {
      case 'schedule': {
        const result = validateSchedule(trigger.cron, trigger.timezone);
        return result.valid ? null : `Invalid schedule: ${result.error}`;
      }
      case 'webhook':
        return null;
      case 'file-watch':
        if (!trigger.path?.trim()) {
          return 'A folder or file path to watch is required';
        }
        if (!Array.isArray(trigger.events) || trigger.events.length === 0) {
          return 'At least one file event is required';
        }
        return null;
      case 'mcp-poll': {
        if (!trigger.serverName || !trigger.toolName) {
          return 'A server and tool are required';
        }
        if (trigger.cron) {
          const result = validateSchedule(trigger.cron, trigger.timezone);
          if (!result.valid) {
            return `Invalid schedule: ${result.error}`;
          }
        }
        if (trigger.evaluate?.mode === 'new-items' && !trigger.evaluate.idField?.trim()) {
          return 'An id field is required to detect new items';
        }
        if (
          (trigger.evaluate?.mode === 'llm-gate' || trigger.evaluate?.mode === 'flow-gate') &&
          !trigger.evaluate.condition?.trim()
        ) {
          return 'A condition is required for the AI to check';
        }
        if (trigger.evaluate?.mode === 'llm-gate' && !trigger.evaluate.modelId) {
          return 'A model is required to check the condition';
        }
        if (trigger.evaluate?.mode === 'flow-gate' && !trigger.evaluate.flowId) {
          return 'A flow is required to check the condition';
        }
        return null;
      }
      case 'url-watch': {
        try {
          const parsed = new URL(trigger.url ?? '');
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return 'The URL must start with http:// or https://';
          }
        } catch {
          return 'A valid URL is required';
        }
        const result = validateSchedule(trigger.cron, trigger.timezone);
        return result.valid ? null : `Invalid schedule: ${result.error}`;
      }
      case 'flow-event': {
        const src = trigger.source;
        const set = [src?.executionId, src?.flowId, src?.flowName, src?.topic].filter(
          v => typeof v === 'string' && v.trim().length > 0
        );
        if (set.length !== 1) {
          return 'Choose exactly one source: a flow, a planned execution, or a signal topic';
        }
        // A topic source (issue #117) reacts to `signal` node emissions, which
        // have no completed/error status, so `on` is not required for it. A
        // flow/execution source still requires at least one terminal outcome.
        const isTopicSource = typeof src?.topic === 'string' && src.topic.trim().length > 0;
        if (!isTopicSource) {
          if (!Array.isArray(trigger.on) || trigger.on.length === 0) {
            return 'Select at least one outcome to react to (completed or error)';
          }
          if (trigger.on.some(s => s !== 'completed' && s !== 'error')) {
            return 'Outcomes must be "completed" or "error"';
          }
        }
        if (trigger.outputMatch?.regex) {
          try {
            // eslint-disable-next-line no-new
            new RegExp(trigger.outputMatch.regex);
          } catch (error) {
            return `Invalid output-match regex: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        if (
          trigger.maxChainDepth !== undefined &&
          (!Number.isInteger(trigger.maxChainDepth) || trigger.maxChainDepth < 1)
        ) {
          return 'Max chain depth must be a positive whole number';
        }
        if (
          trigger.minIntervalMs !== undefined &&
          (!Number.isFinite(trigger.minIntervalMs) || trigger.minIntervalMs < 0)
        ) {
          return 'Minimum interval must be zero or more milliseconds';
        }
        return null;
      }
      default:
        return 'Unknown trigger type';
    }
  }

  // --- overlap tracking (issue #121) ---------------------------------------

  /** True while at least one run for this execution is in flight. */
  isRunning(id: string): boolean {
    const runs = this.running.get(id);
    return runs !== undefined && runs.size > 0;
  }

  /** Register an in-flight run (idempotent per runId). */
  private addRunning(id: string, runId: string, firedAt: string): void {
    let runs = this.running.get(id);
    if (!runs) {
      runs = new Map<string, string>();
      this.running.set(id, runs);
    }
    runs.set(runId, firedAt);
  }

  /** Clear a finished run; drops the id entirely once nothing is left running. */
  private removeRunning(id: string, runId: string): void {
    const runs = this.running.get(id);
    if (!runs) {
      return;
    }
    runs.delete(runId);
    if (runs.size === 0) {
      this.running.delete(id);
    }
  }

  /** Earliest start time among the in-flight runs (drives the live timer). */
  private earliestRunningSince(id: string): string | undefined {
    const runs = this.running.get(id);
    if (!runs || runs.size === 0) {
      return undefined;
    }
    let earliest: string | undefined;
    for (const startedAt of runs.values()) {
      // ISO-8601 timestamps sort lexicographically, so a string compare is fine.
      if (earliest === undefined || startedAt < earliest) {
        earliest = startedAt;
      }
    }
    return earliest;
  }

  /**
   * Build a `skipped` RunRecord for a queued fire that was cancelled or
   * re-validated away (issue #122). Kept as a helper so delete/pause/update and
   * the drainQueue re-check produce identical, auditable outcomes.
   */
  private skippedRecord(fire: QueuedFire, reason: string): RunRecord {
    const at = new Date().toISOString();
    return {
      runId: fire.runId,
      conversationId: '',
      firedAt: at,
      finishedAt: at,
      status: 'skipped',
      triggerSummary: fire.payload.summary,
      error: reason,
    };
  }

  /**
   * Cancel every fire queued for an execution id and settle its awaiter so
   * poll/url-watch `onFire` callers never hang (issue #122). Each pending
   * QueuedFire resolves with a `skipped` RunRecord carrying `reason`.
   *
   * @param appendAudit when true, also persist the skipped record to run
   *   history (pause/update — storage still exists). MUST be false for a hard
   *   delete: appendRunRecord is a read-modify-write that would recreate the
   *   just-erased `planned-execution-runs/<id>.json` — the reported
   *   resurrection bug.
   */
  private async cancelQueued(id: string, reason: string, appendAudit: boolean): Promise<void> {
    const queue = this.queued.get(id);
    if (!queue || queue.length === 0) {
      return;
    }
    this.queued.delete(id);
    for (const fire of queue) {
      const record = this.skippedRecord(fire, reason);
      if (appendAudit) {
        try {
          await appendRunRecord(id, record);
        } catch (error) {
          log.warn(`Failed to record cancelled queued fire for ${id}:`, error);
        }
      }
      fire.resolve(record);
    }
    log.info(`Cancelled ${queue.length} queued fire(s) for ${id}: ${reason}`);
  }

  /**
   * Start the next queued fire ('queue' overlap strategy) once nothing is
   * running for this id. Called from fire()'s finally so the queue drains FIFO,
   * one run at a time. The dequeued run reuses fire() (so it re-checks the
   * encryption guard etc.) and resolves the caller's promise with its outcome.
   *
   * Defense-in-depth (issue #122): drainQueue runs off fire()'s finally and is
   * not awaited by the lifecycle methods, so a delete/pause/update can land
   * mid-drain. Before re-entering fire() we reload the execution and re-check
   * existence/enabled/pause; a since-deleted, disabled, or paused execution
   * resolves the queued fire `skipped` and does NOT run the flow (nor recreate
   * storage for a deleted id). The reload also means a surviving fire runs the
   * FRESH config, which resolves the update()-staleness sub-bug.
   */
  private drainQueue(id: string): void {
    const queue = this.queued.get(id);
    if (!queue || queue.length === 0) {
      return;
    }
    if (this.isRunning(id)) {
      // A run is still in flight (e.g. a parallel run) — drain when it ends.
      return;
    }
    const next = queue.shift();
    if (queue.length === 0) {
      this.queued.delete(id);
    }
    if (!next) {
      return;
    }
    void (async () => {
      const current = await this.get(id);
      if (!current || !current.enabled || this.pausedCache) {
        const reason = !current
          ? 'execution deleted'
          : !current.enabled
            ? 'execution disabled'
            : 'scheduler paused';
        // Do NOT appendRunRecord here: a deleted id would be resurrected, and a
        // disabled/paused execution's cancellation is recorded by the lifecycle
        // method that caused it. Just settle the awaiter and stop draining.
        next.resolve(this.skippedRecord(next, reason));
        return;
      }
      // Re-fire with the freshly reloaded config (keeps the original runId).
      const record = await this.fire(current, next.payload, next.runId);
      next.resolve(record);
    })().catch(error => log.error(`Queued fire failed for ${id}:`, error));
  }

  // --- exclusive mode (issue #171) -----------------------------------------

  /** True when NO run is in flight across ANY execution (scheduler-global idle). */
  private isSchedulerIdle(): boolean {
    for (const runs of this.running.values()) {
      if (runs.size > 0) {
        return false;
      }
    }
    return true;
  }

  /** True while an exclusive execution holds OR is waiting to acquire the lock. */
  private isExclusiveActive(): boolean {
    return this.exclusiveHolder !== null || this.exclusiveWaiting.length > 0;
  }

  /**
   * The nonExclusiveBehavior currently governing non-exclusive fires: the
   * holder's when the lock is held, otherwise the head waiter's; default
   * 'queue'. Config is read fresh whenever a fire (re)enters the exclusive gate.
   */
  private currentExclusiveBehavior(): 'queue' | 'skip' | 'error' {
    if (this.exclusiveHolder !== null) {
      return this.exclusiveHolderBehavior;
    }
    return this.exclusiveWaiting[0]?.execution.nonExclusiveBehavior ?? 'queue';
  }

  /**
   * For the webhook route (issue #171): if a NON-exclusive fire of this
   * execution would be gated right now by an active exclusive lock, return the
   * governing behavior; otherwise null. Lets the HTTP layer answer 423 for the
   * 'error' behavior without duplicating the gating logic.
   */
  exclusiveGateFor(execution: PlannedExecution): 'queue' | 'skip' | 'error' | null {
    if (execution.exclusive === true || !this.isExclusiveActive()) {
      return null;
    }
    return this.currentExclusiveBehavior();
  }

  /**
   * Progress the scheduler-global exclusive machinery after a run ends or a
   * lifecycle change (issue #171). A waiting exclusive claims the freshly-idle
   * window FIRST; only when NO exclusive is active are blocked non-exclusive
   * fires released — so a waiting exclusive never loses the idle window to the
   * non-exclusive backlog (the issue's "clean tree" guarantee).
   */
  private drainExclusive(): void {
    if (
      this.exclusiveHolder === null &&
      this.exclusiveWaiting.length > 0 &&
      this.isSchedulerIdle()
    ) {
      this.acquireNextExclusive();
      return;
    }
    if (!this.isExclusiveActive()) {
      this.drainBlockedByExclusive();
    }
  }

  /**
   * Pop the next waiting exclusive fire and run it, provided the scheduler is
   * idle and the lock is free. Claims the lock SYNCHRONOUSLY (before any await)
   * so no non-exclusive fire can slip through the async config re-check. The
   * re-fire reloads the fresh config (like drainQueue) and re-validates that the
   * execution still exists, is enabled, unpaused and still exclusive.
   */
  private acquireNextExclusive(): void {
    if (this.exclusiveHolder !== null || !this.isSchedulerIdle()) {
      return;
    }
    const next = this.exclusiveWaiting.shift();
    if (!next) {
      return;
    }
    const id = next.execution.id;
    // Provisionally claim the lock synchronously.
    this.exclusiveHolder = id;
    this.exclusiveHolderBehavior = next.execution.nonExclusiveBehavior ?? 'queue';
    void (async () => {
      const current = await this.get(id);
      if (!current || !current.enabled || this.pausedCache || current.exclusive !== true) {
        const reason = !current
          ? 'execution deleted'
          : !current.enabled
            ? 'execution disabled'
            : this.pausedCache
              ? 'scheduler paused'
              : 'no longer exclusive';
        if (this.exclusiveHolder === id) {
          this.exclusiveHolder = null;
        }
        next.resolve(this.skippedRecord(next, reason));
        // Try the next waiter, or release the blocked non-exclusive backlog.
        this.drainExclusive();
        return;
      }
      // Hold against the freshest config.
      this.exclusiveHolderBehavior = current.nonExclusiveBehavior ?? 'queue';
      const record = await this.fire(current, next.payload, next.runId);
      next.resolve(record);
    })().catch(error => {
      if (this.exclusiveHolder === id) {
        this.exclusiveHolder = null;
      }
      log.error(`Exclusive acquire failed for ${id}:`, error);
      next.resolve(this.skippedRecord(next, 'exclusive acquire failed'));
      this.drainExclusive();
    });
  }

  /**
   * Release every non-exclusive fire deferred while an exclusive held the lock
   * (issue #171). Re-fires each against its fresh config, re-checking
   * existence/enabled/pause so a since-removed execution resolves `skipped`.
   */
  private drainBlockedByExclusive(): void {
    if (this.blockedByExclusive.length === 0) {
      return;
    }
    const pending = this.blockedByExclusive;
    this.blockedByExclusive = [];
    for (const fire of pending) {
      void (async () => {
        const current = await this.get(fire.execution.id);
        if (!current || !current.enabled || this.pausedCache) {
          const reason = !current
            ? 'execution deleted'
            : !current.enabled
              ? 'execution disabled'
              : 'scheduler paused';
          fire.resolve(this.skippedRecord(fire, reason));
          return;
        }
        const record = await this.fire(current, fire.payload, fire.runId);
        fire.resolve(record);
      })().catch(error =>
        log.error(`Deferred non-exclusive fire failed for ${fire.execution.id}:`, error)
      );
    }
  }

  /**
   * Cancel exclusive-mode waiting/blocked fires for ONE id (issue #171),
   * settling each awaiter with a `skipped` record so poll/url-watch onFire never
   * hang — the same contract as cancelQueued for the overlap queue.
   */
  private async cancelExclusiveWaiting(
    id: string,
    reason: string,
    appendAudit: boolean
  ): Promise<void> {
    const matches: QueuedFire[] = [];
    this.exclusiveWaiting = this.exclusiveWaiting.filter(f => {
      if (f.execution.id === id) {
        matches.push(f);
        return false;
      }
      return true;
    });
    this.blockedByExclusive = this.blockedByExclusive.filter(f => {
      if (f.execution.id === id) {
        matches.push(f);
        return false;
      }
      return true;
    });
    if (matches.length === 0) {
      return;
    }
    for (const fire of matches) {
      const record = this.skippedRecord(fire, reason);
      if (appendAudit) {
        try {
          await appendRunRecord(id, record);
        } catch (error) {
          log.warn(`Failed to record cancelled exclusive fire for ${id}:`, error);
        }
      }
      fire.resolve(record);
    }
    log.info(`Cancelled ${matches.length} exclusive-related fire(s) for ${id}: ${reason}`);
  }

  /**
   * Cancel ALL exclusive-mode waiting/blocked fires regardless of id (issue
   * #171) — used by the global pause switch. Never recreates deleted storage:
   * appendAudit is true here because pause leaves every execution's storage in
   * place.
   */
  private async cancelAllExclusiveWaiting(reason: string, appendAudit: boolean): Promise<void> {
    const all = [...this.exclusiveWaiting, ...this.blockedByExclusive];
    this.exclusiveWaiting = [];
    this.blockedByExclusive = [];
    if (all.length === 0) {
      return;
    }
    for (const fire of all) {
      const record = this.skippedRecord(fire, reason);
      if (appendAudit) {
        try {
          await appendRunRecord(fire.execution.id, record);
        } catch (error) {
          log.warn(`Failed to record cancelled exclusive fire for ${fire.execution.id}:`, error);
        }
      }
      fire.resolve(record);
    }
    log.info(`Cancelled ${all.length} exclusive-related fire(s): ${reason}`);
  }

  // --- status --------------------------------------------------------------

  getStatus(execution: PlannedExecution): PlannedExecutionStatus {
    const trigger = this.armed.get(execution.id);
    // Webhook triggers have no armed component — they count as armed whenever
    // the execution is enabled and the scheduler isn't paused.
    const armed =
      trigger !== undefined ||
      (execution.enabled &&
        execution.trigger.type === 'webhook' &&
        this.started &&
        !this.pausedCache);
    const runningSince = this.earliestRunningSince(execution.id);
    // When NOT armed, tell the UI *why* so it can render a truthful hint
    // instead of a bare "Not armed" (issue #118). A disabled execution is
    // never armed regardless of the global switch, so check it first; then
    // the global pause. Anything else (idle/erroring) stays undefined.
    const notArmedReason: PlannedExecutionStatus['notArmedReason'] = armed
      ? undefined
      : !execution.enabled
        ? 'disabled'
        : this.pausedCache
          ? 'paused'
          : undefined;
    // Exclusive-mode live state (issue #171): surface who holds the global lock
    // and whether this (non-exclusive) execution is currently gated by it, so
    // the UI can show an "Exclusive" badge and a "blocked by exclusive" hint.
    const exclusiveHolderId = this.exclusiveHolder ?? undefined;
    const blockedByExclusive = execution.exclusive !== true && this.isExclusiveActive();
    return {
      armed,
      notArmedReason,
      nextRun: trigger?.nextRun ? trigger.nextRun() : undefined,
      lastTriggerError: this.lastTriggerErrors.get(execution.id),
      running: runningSince !== undefined,
      runningSince,
      exclusiveHolderId,
      blockedByExclusive,
    };
  }

  // --- firing --------------------------------------------------------------

  /**
   * Manual "Run now" — works even when disabled or globally paused. It also
   * bypasses the overlap policy (issue #121): a manual run is an explicit user
   * action, so it always starts immediately rather than being skipped, queued,
   * or rejected by an in-flight run. It is still tracked in `running`.
   */
  async runNow(id: string): Promise<{ record?: RunRecord; error?: string }> {
    const execution = await this.get(id);
    if (!execution) {
      return { error: `No planned execution with id "${id}"` };
    }
    const record = await this.fire(
      execution,
      { kind: 'manual', summary: 'Manual run' },
      uuidv4(),
      true
    );
    return { record };
  }

  /**
   * Run the bound flow for a trigger fire. Never throws — every outcome
   * (including overlap skips and crashes) becomes a RunRecord.
   */
  async fire(
    execution: PlannedExecution,
    payload: TriggerFirePayload,
    runId: string = uuidv4(),
    /**
     * Skip the overlap policy entirely and start immediately (issue #121).
     * Used by manual runNow — an explicit user action is never skipped/queued.
     */
    bypassOverlap = false
  ): Promise<RunRecord> {
    const firedAt = new Date().toISOString();

    // Locked USER encryption: the flow would resolve ${global:...} bindings and
    // decrypt model API keys against a DEK that isn't in memory. Never run it —
    // record a `skipped` run with a stable, human-readable reason (mirroring the
    // overlap-skip precedent, which reuses the `error` field). This guards EVERY
    // fire path (schedule, poll, watch, catch-up, and manual runNow), since they
    // all decrypt the same secrets. Crucially, no trigger baseline is touched:
    // poll/watch onFire only advance their cursor/hash after a `completed` run,
    // so returning `skipped` here re-observes the work naturally after unlock —
    // without queueing or bursting.
    if (await isEncryptionLocked()) {
      const record: RunRecord = {
        runId,
        conversationId: '',
        firedAt,
        finishedAt: firedAt,
        status: 'skipped',
        triggerSummary: payload.summary,
        error: 'encryption locked',
      };
      await appendRunRecord(execution.id, record);
      log.info(`Skipped fire for "${execution.name}" — encryption locked`);
      return record;
    }

    // Exclusive-mode gating (issue #171): a scheduler-GLOBAL mutual-exclusion
    // lock, layered AFTER the encryption guard and BEFORE the per-execution
    // overlap policy. A manual run (bypassOverlap) is an explicit user override
    // and is exempt; a flow-event fire is emitted synchronously as another run
    // finishes, so gating it here could deadlock the chain — it too is exempt.
    const isChainedFire = payload.kind === 'flow-event';
    if (!bypassOverlap && !isChainedFire) {
      if (execution.exclusive === true) {
        // Exclusive: only start when the scheduler is globally idle AND the lock
        // is free — unless this fire already holds it (dequeued from the
        // exclusive-waiting queue by acquireNextExclusive).
        if (this.exclusiveHolder !== execution.id) {
          if (this.exclusiveHolder !== null || !this.isSchedulerIdle()) {
            const depth = this.exclusiveWaiting.length;
            if (depth >= SchedulerService.MAX_QUEUE_DEPTH) {
              const record: RunRecord = {
                runId,
                conversationId: '',
                firedAt,
                finishedAt: firedAt,
                status: 'skipped',
                triggerSummary: payload.summary,
                error: `Exclusive wait queue full (cap ${SchedulerService.MAX_QUEUE_DEPTH}) — fire dropped`,
              };
              await appendRunRecord(execution.id, record);
              log.warn(`Exclusive wait queue full for "${execution.name}" — dropped fire`);
              return record;
            }
            log.info(
              `Exclusive "${execution.name}" waiting for scheduler to idle (depth ${depth + 1})`
            );
            return new Promise<RunRecord>(resolve => {
              this.exclusiveWaiting.push({ execution, payload, runId, resolve });
            });
          }
          // Idle and lock free — acquire it now (synchronously, before any await).
          this.exclusiveHolder = execution.id;
          this.exclusiveHolderBehavior = execution.nonExclusiveBehavior ?? 'queue';
          log.info(`Exclusive "${execution.name}" acquired the scheduler lock`);
        }
      } else if (this.isExclusiveActive()) {
        // Non-exclusive fire while an exclusive holds/awaits the lock: apply the
        // exclusive execution's nonExclusiveBehavior (default 'queue').
        const behavior = this.currentExclusiveBehavior();
        if (behavior === 'skip') {
          const record: RunRecord = {
            runId,
            conversationId: '',
            firedAt,
            finishedAt: firedAt,
            status: 'skipped',
            triggerSummary: payload.summary,
            error: 'Skipped — an exclusive execution holds the scheduler lock',
          };
          await appendRunRecord(execution.id, record);
          log.info(`Skipped non-exclusive fire for "${execution.name}" — exclusive lock held`);
          return record;
        }
        if (behavior === 'error') {
          const record: RunRecord = {
            runId,
            conversationId: '',
            firedAt,
            finishedAt: firedAt,
            status: 'error',
            triggerSummary: payload.summary,
            error: 'Rejected — an exclusive execution holds the scheduler lock',
          };
          await appendRunRecord(execution.id, record);
          log.info(`Rejected non-exclusive fire for "${execution.name}" — exclusive lock held`);
          return record;
        }
        // behavior === 'queue': defer until the exclusive lock releases.
        const depth = this.blockedByExclusive.length;
        if (depth >= SchedulerService.MAX_QUEUE_DEPTH) {
          const record: RunRecord = {
            runId,
            conversationId: '',
            firedAt,
            finishedAt: firedAt,
            status: 'skipped',
            triggerSummary: payload.summary,
            error: `Exclusive-block queue full (cap ${SchedulerService.MAX_QUEUE_DEPTH}) — fire dropped`,
          };
          await appendRunRecord(execution.id, record);
          log.warn(`Exclusive-block queue full for "${execution.name}" — dropped fire`);
          return record;
        }
        log.info(
          `Deferred non-exclusive fire for "${execution.name}" — exclusive lock held (depth ${depth + 1})`
        );
        return new Promise<RunRecord>(resolve => {
          this.blockedByExclusive.push({ execution, payload, runId, resolve });
        });
      }
    }

    // Overlap policy (issue #121): decide what to do when a fire arrives while
    // a previous run for THIS execution is still in flight. Defaults to 'skip'
    // (historical behavior). The encryption-locked guard above always wins.
    const strategy: OverlapStrategy = execution.overlapStrategy ?? 'skip';
    if (!bypassOverlap && this.isRunning(execution.id)) {
      if (strategy === 'skip') {
        const record: RunRecord = {
          runId,
          conversationId: '',
          firedAt,
          finishedAt: firedAt,
          status: 'skipped',
          triggerSummary: payload.summary,
          // Stable reason string so historical run-history rows stay consistent.
          error: 'Previous run still in progress',
        };
        await appendRunRecord(execution.id, record);
        log.info(`Skipped overlapping fire for "${execution.name}"`);
        return record;
      }
      if (strategy === 'error') {
        const record: RunRecord = {
          runId,
          conversationId: '',
          firedAt,
          finishedAt: firedAt,
          status: 'error',
          triggerSummary: payload.summary,
          error: 'Overlapping run rejected (overlapStrategy=error)',
        };
        await appendRunRecord(execution.id, record);
        log.info(`Rejected overlapping fire for "${execution.name}" (overlapStrategy=error)`);
        return record;
      }
      if (strategy === 'queue') {
        const depth = this.queued.get(execution.id)?.length ?? 0;
        if (depth >= SchedulerService.MAX_QUEUE_DEPTH) {
          const record: RunRecord = {
            runId,
            conversationId: '',
            firedAt,
            finishedAt: firedAt,
            status: 'skipped',
            triggerSummary: payload.summary,
            error: `Overlap queue full (cap ${SchedulerService.MAX_QUEUE_DEPTH}) — fire dropped`,
          };
          await appendRunRecord(execution.id, record);
          log.warn(`Overlap queue full for "${execution.name}" — dropped fire`);
          return record;
        }
        log.info(`Queued overlapping fire for "${execution.name}" (depth ${depth + 1})`);
        // Resolve when the queued fire actually runs (drainQueue reuses fire()).
        // poll/url-watch onFire await THIS promise, so the commit-after-success
        // baseline still advances only on the queued run's real 'completed'.
        return new Promise<RunRecord>(resolve => {
          const queue = this.queued.get(execution.id) ?? [];
          queue.push({ execution, payload, runId, resolve });
          this.queued.set(execution.id, queue);
        });
      }
      // strategy === 'parallel' — fall through and run concurrently.
    }

    this.addRunning(execution.id, runId, firedAt);
    const conversationId = uuidv4();
    let record: RunRecord;
    try {
      log.info(`Firing "${execution.name}" (${payload.kind})`);
      // Timing metadata for the flow: what time it is, when this execution
      // last ran, and when it will run next. Read BEFORE appending the
      // current record, so lastRun is genuinely the previous one.
      const history = await loadRunRecords(execution.id);
      const previousRun = history.length > 0 ? history[history.length - 1] : null;
      const runInfo = {
        executionName: execution.name,
        trigger: payload.kind,
        now: firedAt,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        lastRun: previousRun
          ? { at: previousRun.firedAt, status: previousRun.status }
          : null,
        nextPlannedRun: this.getStatus(execution).nextRun ?? null,
      };
      // Headless approval policy (#115): a scheduled run has no interactive
      // approver. 'auto' (default) keeps the legacy silent auto-run; 'fail'/
      // 'pause' send tools to the approval gate (requireApproval), and the
      // onApprovalRequired policy decides what happens there. A 'pause' run must
      // persist (conversation mode) so its paused state survives to be resumed
      // via /api/approvals.
      const approvalPolicy = execution.approvalPolicy ?? 'auto';
      const requireApproval = approvalPolicy !== 'auto';
      const mode: 'conversation' | 'ephemeral' =
        execution.saveConversations || approvalPolicy === 'pause' ? 'conversation' : 'ephemeral';
      // Lazy import keeps the execution stack out of module-load paths and
      // mirrors SubflowNode's approach to the engine's import cycles.
      const { runFlow } = await import('@/backend/execution/flow/runFlow');
      const result = await runFlow({
        flowId: execution.flowId,
        prompt: this.composePrompt(execution.prompt, payload, runInfo),
        mode,
        conversationId,
        // Tag origin so GET /api/runs/active can surface this as a scheduled run
        // (issue #113).
        source: 'schedule',
        plannedExecutionId: execution.id,
        // Event-chain depth (issue #116/#117): a flow-event/signal-fired run is
        // one hop deeper than the run that triggered it. Threaded onto
        // SharedState so a `signal` node inside this run emits at the right depth
        // and runaway chains trip maxChainDepth. Organic fires are depth 0.
        chainDepth: payload.chainDepth ?? 0,
        // Headless approval handling (#115).
        requireApproval,
        onApprovalRequired: approvalPolicy,
        debug: false,
        // Fresh user turn: routes from the Start node and runs preflight
        // flow validation.
        userTurn: true,
      });
      record = await this.recordFromResult(execution, result, {
        runId,
        conversationId,
        firedAt,
        payload,
      });
    } catch (error) {
      record = {
        runId,
        conversationId,
        firedAt,
        finishedAt: new Date().toISOString(),
        status: 'error',
        triggerSummary: payload.summary,
        error: error instanceof Error ? error.message : String(error),
      };
      log.error(`Run crashed for "${execution.name}":`, error);
    } finally {
      this.removeRunning(execution.id, runId);
      // Release the scheduler-global exclusive lock once the holder has no more
      // in-flight runs (issue #171). A self-parallel exclusive keeps the lock
      // until its LAST run drains.
      if (this.exclusiveHolder === execution.id && !this.isRunning(execution.id)) {
        this.exclusiveHolder = null;
        log.info(`Exclusive "${execution.name}" released the scheduler lock`);
      }
      // Drain order (issue #171): a waiting exclusive claims the freshly-idle
      // window BEFORE blocked non-exclusive fires refill the scheduler; then the
      // per-execution overlap queue.
      this.drainExclusive();
      // Start the next queued fire (if any) now that this run has ended.
      this.drainQueue(execution.id);
    }
    // If the execution was hard-deleted while this run was in flight (issue
    // #122), do NOT appendRunRecord (it would recreate the just-erased
    // planned-execution-runs/<id>.json) nor publish a terminal event for a
    // ghost execution. The scheduler has no cancellation handle for a live
    // runFlow, so suppressing its side effects is the minimal safe fix.
    if ((await this.get(execution.id)) === null) {
      log.info(`Dropping run record for deleted execution ${execution.id}`);
      return record;
    }
    await appendRunRecord(execution.id, record);
    // Broadcast terminal runs so `flow-event` triggers can react (issue #116).
    // Skips (overlap/encryption-lock) return earlier and never reach here.
    if (record.status === 'completed' || record.status === 'error') {
      await this.publishFlowRunEvent(execution, record, payload);
    }
    return record;
  }

  /**
   * Map a runFlow result to a RunRecord, handling the headless approval
   * outcomes (#115). A run that hit a tool needing approval either failed fast
   * (approvalPolicy 'fail' → a structured approval_required error) or is parked
   * awaiting approval ('pause' → awaiting_tool_approval); both map to a
   * dedicated `needs_approval` run status. Crucially `needs_approval` is not
   * `completed`, so poll/url-watch change baselines (which only advance on
   * `completed`) are not moved — the work is re-observable after resolution.
   */
  private async recordFromResult(
    execution: PlannedExecution,
    result: FlowRunResult,
    meta: { runId: string; conversationId: string; firedAt: string; payload: TriggerFirePayload }
  ): Promise<RunRecord> {
    const { runId, conversationId, firedAt, payload } = meta;
    const finishedAt = new Date().toISOString();

    const isPause = result.status === 'awaiting_tool_approval';
    const isFailFast =
      result.status === 'error' && result.error?.details?.type === 'approval_required';
    if (isPause || isFailFast) {
      const pendingToolCalls = (result.pendingToolCalls ?? []).map(tc => ({
        id: tc.id,
        name: tc.type === 'function' ? tc.function.name : String(tc.type),
      }));
      const record: RunRecord = {
        runId,
        conversationId,
        firedAt,
        finishedAt,
        status: 'needs_approval',
        triggerSummary: payload.summary,
        outputText: this.truncateOutput(result.outputText),
        usage: result.usage,
        error: isFailFast
          ? result.error?.message ?? 'Tool approval required'
          : 'Awaiting tool approval',
        pendingApproval: {
          tool: pendingToolCalls[0]?.name ?? result.error?.details?.name,
          toolCallId: pendingToolCalls[0]?.id,
          pendingToolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
        },
      };
      // Only a 'pause' run is resumable (its state is persisted); register it in
      // the durable approval inbox so /api/approvals can list + resolve it.
      if (isPause) {
        await this.registerPendingApproval(execution, record, pendingToolCalls);
      }
      return record;
    }

    return {
      runId,
      conversationId,
      firedAt,
      finishedAt,
      status: result.status === 'completed' ? 'completed' : 'error',
      triggerSummary: payload.summary,
      outputText: this.truncateOutput(result.outputText),
      usage: result.usage,
      error:
        result.status === 'completed'
          ? undefined
          : result.error?.message ?? `Run ended with status "${result.status}"`,
    };
  }

  /**
   * Write a durable approval-inbox entry for a paused headless run (#115), so
   * GET /api/approvals can surface it and POST /api/approvals/:id can resolve it
   * even across a process restart. Best-effort and never throws — an inbox
   * write problem must not fail the run (the paused SharedState is the source of
   * truth for the resume regardless).
   */
  private async registerPendingApproval(
    execution: PlannedExecution,
    record: RunRecord,
    pendingToolCalls: Array<{ id: string; name: string }>
  ): Promise<void> {
    try {
      let flowName: string | undefined;
      try {
        const { flowService } = await import('@/backend/services/flow');
        flowName = (await flowService.getFlow(execution.flowId))?.name ?? undefined;
      } catch (error) {
        log.debug(`Could not resolve flow name for pending approval (${execution.flowId}):`, error);
      }
      const { putPendingApproval } = await import('./pendingApprovals');
      await putPendingApproval({
        approvalId: record.conversationId,
        conversationId: record.conversationId,
        plannedExecutionId: execution.id,
        flowId: execution.flowId,
        flowName,
        runId: record.runId,
        triggerSummary: record.triggerSummary,
        pendingToolCalls,
        createdAt: record.firedAt,
      });
    } catch (error) {
      log.warn(`Failed to register pending approval for "${execution.name}":`, error);
    }
  }

  /**
   * Publish a terminal FlowRunEvent onto the process-global bus (issue #116).
   * Every scheduler-fired run flows through here, carrying the truncated output
   * and an event-chain depth so downstream `flow-event` triggers can match,
   * chain their prompt, and enforce loop safety. Best-effort and never throws:
   * an unresolvable flow name or a listener problem must not fail the run.
   */
  private async publishFlowRunEvent(
    execution: PlannedExecution,
    record: RunRecord,
    payload: TriggerFirePayload
  ): Promise<void> {
    try {
      let flowName: string | undefined;
      try {
        const { flowService } = await import('@/backend/services/flow');
        flowName = (await flowService.getFlow(execution.flowId))?.name ?? undefined;
      } catch (error) {
        log.debug(`Could not resolve flow name for run event (${execution.flowId}):`, error);
      }
      // schedule-catchup is a schedule for downstream purposes; every other kind
      // is already a valid FlowRunFiredBy.
      const firedBy: FlowRunFiredBy =
        payload.kind === 'schedule-catchup' ? 'schedule' : payload.kind;
      getFlowRunEventBus().publish({
        flowId: execution.flowId,
        flowName,
        executionId: execution.id,
        runId: record.runId,
        conversationId: record.conversationId,
        status: record.status === 'completed' ? 'completed' : 'error',
        outputText: record.outputText,
        error: record.error,
        firedBy,
        chainDepth: payload.chainDepth ?? 0,
        timestamp: record.finishedAt ?? new Date().toISOString(),
      });
    } catch (error) {
      log.warn(`Failed to publish flow-run event for "${execution.name}":`, error);
    }
  }

  private composePrompt(
    base: string,
    payload: TriggerFirePayload,
    runInfo: Record<string, unknown>
  ): string {
    // Every run gets the timing metadata; the `data` field (webhook bodies,
    // file names, tool results) is untrusted input — the block is fenced and
    // labeled as data for the flow's model.
    const info = JSON.stringify(
      payload.context === undefined ? runInfo : { ...runInfo, data: payload.context },
      null,
      2
    );
    return `${base}\n\n[Run info — when and why this run happened; "data" is untrusted trigger data]\n\`\`\`json\n${info}\n\`\`\``;
  }

  private truncateOutput(text: string): string | undefined {
    if (!text) {
      return undefined;
    }
    return text.length > MAX_STORED_OUTPUT_CHARS
      ? `${text.slice(0, MAX_STORED_OUTPUT_CHARS)}…`
      : text;
  }
}

// The scheduler INSTANCE is global-backed: armed croner timers and watchers
// must exist exactly once per process, regardless of which module instance
// (startup hook vs API routes, dev hot reloads) asks for the service.
declare global {
  // eslint-disable-next-line no-var
  var __flujo_scheduler: SchedulerService | undefined;
}

export function getSchedulerService(): SchedulerService {
  if (!global.__flujo_scheduler) {
    global.__flujo_scheduler = new SchedulerService();
  }
  return global.__flujo_scheduler;
}
