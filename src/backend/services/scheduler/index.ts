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
import { ArmedTrigger } from './triggers/types';
import { armSchedule, isCatchUpDue, validateSchedule } from './triggers/schedule';
import { armFileWatch } from './triggers/fileWatch';
import { armMcpPoll, MIN_POLL_INTERVAL_MS } from './triggers/mcpPoll';
import { appendRunRecord, deleteRunHistory, loadLastRunRecord } from './runHistory';
import { deleteExecutionState, loadExecutionState, saveExecutionState } from './state';

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
  /** Execution ids with a flow run currently in flight (overlap policy: skip). */
  private running = new Set<string>();
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
            onFire: ({ summary, context }) => {
              this.lastTriggerErrors.delete(execution.id);
              void this.fire(execution, { kind: 'mcp-poll', summary, context });
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
   * Create a new execution. Fills id/timestamps/webhook-token server-side.
   * Returns the stored execution or a validation error.
   */
  async create(
    input: Omit<PlannedExecution, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<{ execution?: PlannedExecution; error?: string }> {
    const error = this.validateInput(input);
    if (error) {
      return { error };
    }
    const now = new Date().toISOString();
    const execution: PlannedExecution = {
      ...input,
      trigger: this.normalizeTrigger(input.trigger),
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };
    const file = await this.loadFile();
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
   * Fill/clamp server-side trigger fields: an empty webhook token generates
   * one; poll intervals are floored to the minimum.
   */
  private normalizeTrigger(trigger: PlannedExecution['trigger']): PlannedExecution['trigger'] {
    if (trigger?.type === 'webhook' && !trigger.token) {
      return { ...trigger, token: uuidv4() };
    }
    if (trigger?.type === 'mcp-poll') {
      return { ...trigger, intervalMs: Math.max(trigger.intervalMs || 0, MIN_POLL_INTERVAL_MS) };
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
      case 'mcp-poll':
        if (!trigger.serverName || !trigger.toolName) {
          return 'A server and tool are required';
        }
        if (trigger.evaluate?.mode === 'new-items' && !trigger.evaluate.idField?.trim()) {
          return 'An id field is required to detect new items';
        }
        if (trigger.evaluate?.mode === 'llm-gate' && !trigger.evaluate.condition?.trim()) {
          return 'A condition is required for the AI to check';
        }
        return null;
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
    return {
      armed,
      nextRun: trigger?.nextRun ? trigger.nextRun() : undefined,
      lastTriggerError: this.lastTriggerErrors.get(execution.id),
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

    this.running.add(execution.id);
    const conversationId = uuidv4();
    let record: RunRecord;
    try {
      log.info(`Firing "${execution.name}" (${payload.kind})`);
      // Lazy import keeps the execution stack out of module-load paths and
      // mirrors SubflowNode's approach to the engine's import cycles.
      const { runFlow } = await import('@/backend/execution/flow/runFlow');
      const result = await runFlow({
        flowId: execution.flowId,
        prompt: this.composePrompt(execution.prompt, payload),
        mode: execution.saveConversations ? 'conversation' : 'ephemeral',
        conversationId,
        // Headless: an approval pause would suspend the run with no resumer.
        requireApproval: false,
        debug: false,
        // Fresh user turn: routes from the Start node and runs preflight
        // flow validation.
        userTurn: true,
      });
      record = {
        runId,
        conversationId,
        firedAt,
        finishedAt: new Date().toISOString(),
        status: result.status === 'completed' ? 'completed' : 'error',
        triggerSummary: payload.summary,
        outputText: this.truncateOutput(result.outputText),
        usage: result.usage,
        error:
          result.status === 'completed'
            ? undefined
            : result.error?.message ?? `Run ended with status "${result.status}"`,
      };
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
    return record;
  }

  private composePrompt(base: string, payload: TriggerFirePayload): string {
    if (payload.context === undefined) {
      return base;
    }
    const context = JSON.stringify(payload.context, null, 2);
    // The context block is untrusted input (webhook bodies, file names, tool
    // results) — fence it and label it as data for the flow's model.
    return `${base}\n\n[Trigger context — data that caused this run]\n\`\`\`json\n${context}\n\`\`\``;
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
