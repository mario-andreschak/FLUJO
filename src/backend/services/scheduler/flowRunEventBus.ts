import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/scheduler/flowRunEventBus');

/**
 * Who caused the terminal run that produced a FlowRunEvent. Trigger kinds plus
 * the two runFlow origins (`chat`/`api`) that aren't scheduler-driven.
 */
export type FlowRunFiredBy =
  | 'schedule'
  | 'webhook'
  | 'file'
  | 'mcp-poll'
  | 'url-watch'
  | 'flow-event'
  | 'manual'
  | 'chat'
  | 'api';

/**
 * A flow reached a terminal state (issue #116). Published exactly once per
 * terminal run at depth 0 (never per subflow stage) and consumed by armed
 * `flow-event` triggers. Kept intentionally lightweight so the bus module has
 * no MCP/model/flow imports and scheduler unit tests stay isolated.
 */
export interface FlowRunEvent {
  /** Discriminant. Optional and defaulting to a terminal-run event so existing
   *  publishers (scheduler / runFlow) need no change; a `signal` node publishes
   *  a {@link FlowSignalEvent} instead (issue #117). */
  kind?: 'run';
  /** The flow that ran. */
  flowId: string;
  /** The flow's current name, best-effort (may be undefined if unresolvable). */
  flowName?: string;
  /** Planned-execution id, when the run was fired by the scheduler. */
  executionId?: string;
  /** The run's conversation id (the run identity for this event). */
  runId: string;
  conversationId: string;
  /** Terminal status. Only `completed`/`error` are ever published. */
  status: 'completed' | 'error';
  /** Final assistant output, already truncated at the emit site. */
  outputText?: string;
  /** Error message when `status === 'error'`. */
  error?: string;
  /** What caused this run. */
  firedBy: FlowRunFiredBy;
  /** Event-chain depth (0 = organic; +1 per flow-event hop). Loop safety. */
  chainDepth: number;
  /** ISO timestamp the run finished. */
  timestamp: string;
}

/**
 * An in-flow `signal` node was traversed (issue #117): a deterministic,
 * mid-run, fire-and-forget emission of `{ topic, payload }` onto the same bus,
 * consumed by armed `flow-event` triggers configured with a topic source. It is
 * NOT a terminal-run event (no completed/error status) — the shared
 * `chainDepth` still bounds runaway signal chains exactly like completion
 * events.
 */
export interface FlowSignalEvent {
  kind: 'signal';
  /** The emitted topic (matched against a trigger's `source.topic`). */
  topic: string;
  /** The resolved payload (the node's template after `${var:NAME}` expansion). */
  payload: string;
  /** The flow that contains the signal node. */
  emitterFlowId: string;
  /** The emitter flow's current name, best-effort. */
  flowName?: string;
  /** The emitting run's conversation/run id. */
  runId: string;
  conversationId: string;
  /** What caused the emitting run. */
  firedBy: FlowRunFiredBy;
  /** The emitting run's event-chain depth (0 = organic). The listener
   *  increments it and enforces maxChainDepth. */
  chainDepth: number;
  /** ISO timestamp the signal was emitted. */
  timestamp: string;
}

/** Anything the bus can carry: a terminal-run event or a signal-node event. */
export type FlowEvent = FlowRunEvent | FlowSignalEvent;

/** Type guard: narrow a bus event to a signal-node emission. */
export function isFlowSignalEvent(event: FlowEvent): event is FlowSignalEvent {
  return event.kind === 'signal';
}

export type FlowRunEventListener = (event: FlowEvent) => void;

/**
 * Process-global emitter for terminal flow runs. Global-backed for the same
 * reason as the scheduler instance and the MCP client maps: in production
 * `next start`, the module instance running startup is not the one serving API
 * routes, and publishers (runFlow, the scheduler) must reach the subscribers
 * (armed flow-event triggers) that live on whichever instance armed them.
 */
export class FlowRunEventBus {
  private listeners = new Set<FlowRunEventListener>();

  /** Notify every current subscriber. A throwing listener never blocks others. */
  publish(event: FlowEvent): void {
    if (this.listeners.size === 0) {
      return;
    }
    const label = isFlowSignalEvent(event)
      ? `signal topic=${event.topic} emitter=${event.emitterFlowId}`
      : `flow=${event.flowId} status=${event.status}`;
    log.debug(
      `Publishing flow event: ${label} ` +
        `firedBy=${event.firedBy} depth=${event.chainDepth} listeners=${this.listeners.size}`
    );
    // Snapshot so a listener that unsubscribes (or arms another) during
    // dispatch can't mutate the set mid-iteration.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        log.warn('A flow-run event listener threw:', error);
      }
    }
  }

  /** Subscribe; returns an idempotent unsubscribe. */
  subscribe(listener: FlowRunEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test/inspection helper. */
  get listenerCount(): number {
    return this.listeners.size;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __flujo_flow_run_event_bus: FlowRunEventBus | undefined;
}

export function getFlowRunEventBus(): FlowRunEventBus {
  if (!global.__flujo_flow_run_event_bus) {
    global.__flujo_flow_run_event_bus = new FlowRunEventBus();
  }
  return global.__flujo_flow_run_event_bus;
}
