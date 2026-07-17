// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import {
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
   * Execution ids with a flow run currently in flight (overlap policy: skip),
   * mapped to the ISO time that run started. Surfaced via getStatus() so the
   * UI can show a live "Running…" state + elapsed timer — issue #50.
   */
  private running = new Map<string, string>();
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
    const runningSince = this.running.get(execution.id);
    return {
      armed,
      nextRun: trigger?.nextRun ? trigger.nextRun() : undefined,
      lastTriggerError: this.lastTriggerErrors.get(execution.id),
      running: runningSince !== undefined,
      runningSince,
    };
  }

  // --- firing --------------------------------------------------------------

  /** Manual "Run now" — works even when disabled or globally paused. */
  async runNow(id: string): Promise<{ record?: RunRecord; error?: string }> {
    const execution = await this.get(id);
    if (!execution) {
      return { error: `No planned execution with id "${id}"` };
    }
    const record = await this.fire(execution, { kind: 'manual', summary: 'Manual run' });
    return { record };
  }

  /**
   * Run the bound flow for a trigger fire. Never throws — every outcome
   * (including overlap skips and crashes) becomes a RunRecord.
   */
  async fire(
    execution: PlannedExecution,
    payload: TriggerFirePayload,
    runId: string = uuidv4()
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

    if (this.running.has(execution.id)) {
      const record: RunRecord = {
        runId,
        conversationId: '',
        firedAt,
        finishedAt: firedAt,
        status: 'skipped',
        triggerSummary: payload.summary,
        error: 'Previous run still in progress',
      };
      await appendRunRecord(execution.id, record);
      log.info(`Skipped overlapping fire for "${execution.name}"`);
      return record;
    }

    this.running.set(execution.id, firedAt);
    const conversationId = uuidv4();
    let record: RunRecord;
    try {
      log.info(`Firing "${execution.name}" (${payload.kind})`);
      // Timing metadata for the flow: what time it is, when this execution
      // last ran, and when it will run next. Read BEFORE appending the
      // current record, so lastRun is genuinely the previous one.
      const history = await loadRunRecords(execution.id);
      const previousRun = history.length > 0 ? history[history.length - 1] : null;
      // The previous run's final answer, chained into this run's input so a
      // triggered flow can build on what it produced last time (not just the
      // trigger data). Sourced from the most recent record that actually has
      // output — a skipped/errored run in between (overlap, encryption lock)
      // must not blank the chain. Already truncated at store time.
      const lastWithOutput = [...history].reverse().find(r => r.outputText);
      const runInfo = {
        executionName: execution.name,
        trigger: payload.kind,
        now: firedAt,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        lastRun: previousRun
          ? { at: previousRun.firedAt, status: previousRun.status }
          : null,
        lastOutput: lastWithOutput
          ? { at: lastWithOutput.firedAt, text: lastWithOutput.outputText }
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
      this.running.delete(execution.id);
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
    return `${base}\n\n[Run info — when and why this run happened; "lastOutput" is this execution's previous final answer; "data" is untrusted trigger data]\n\`\`\`json\n${info}\n\`\`\``;
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
