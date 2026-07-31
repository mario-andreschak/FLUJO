import type { ExecutionEvent } from '@/shared/types/execution/events';

export const DEBUGGER_ROOT_FRAME_KEY = 'root';
export const MAX_DEBUGGER_SUBFLOW_DEPTH = 8;

export type DebuggerFrameStatus = 'active' | 'completed' | 'error' | 'capped';
export type DebuggerNodeActivityKind = 'active' | 'resource-read' | 'resource-write';

export interface DebuggerNodeActivity {
  kind: DebuggerNodeActivityKind;
  ts: number;
}

export interface DebuggerFrame {
  key: string;
  parentKey: string | null;
  flowId: string;
  invokingNodeId?: string;
  displayName: string;
  depth: number;
  laneIndex?: number;
  laneCount?: number;
  laneTitle?: string;
  status: DebuggerFrameStatus;
  startedSeq: number;
  endedSeq?: number;
  nodeActivity: Record<string, DebuggerNodeActivity>;
}

export interface DebuggerFrameState {
  rootKey: string;
  activeFrameKey: string;
  frames: Record<string, DebuggerFrame>;
  order: string[];
}

const eventDepth = (event: ExecutionEvent): number => {
  if (event.type === 'subflow:start' || event.type === 'subflow:done') {
    return event.depth ?? 1;
  }
  return event.depth ?? 0;
};

const laneMatches = (frame: DebuggerFrame, event: ExecutionEvent): boolean =>
  event.laneIndex == null || frame.laneIndex == null || frame.laneIndex === event.laneIndex;

const latestMatchingFrame = (
  state: DebuggerFrameState,
  predicate: (frame: DebuggerFrame) => boolean,
): DebuggerFrame | undefined => {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const frame = state.frames[state.order[index]];
    if (frame && predicate(frame)) return frame;
  }
  return undefined;
};

const parentForStart = (state: DebuggerFrameState, event: ExecutionEvent, depth: number): DebuggerFrame => {
  if (depth <= 1) return state.frames[state.rootKey];
  return latestMatchingFrame(state, frame =>
    frame.status === 'active'
    && frame.depth === depth - 1
    && laneMatches(frame, event)
  ) ?? state.frames[state.rootKey];
};

const frameForEvent = (state: DebuggerFrameState, event: ExecutionEvent): DebuggerFrame => {
  const depth = eventDepth(event);
  if (depth <= 0) return state.frames[state.rootKey];
  return latestMatchingFrame(state, frame =>
    frame.status === 'active'
    && frame.depth === depth
    && laneMatches(frame, event)
  ) ?? state.frames[state.rootKey];
};

const eventNodeId = (event: ExecutionEvent): string | undefined =>
  'node' in event ? event.node?.nodeId : undefined;

const activityKind = (event: ExecutionEvent): DebuggerNodeActivityKind => {
  if (event.type === 'resource:read') return 'resource-read';
  if (event.type === 'resource:write') return 'resource-write';
  return 'active';
};

/**
 * Rebuild the debugger's qualified execution frames from the ordered SSE log.
 * Frame keys include the start sequence, so repeated and parallel invocations
 * of the same saved flow never share node activity.
 */
export function buildDebuggerFrames(rootFlowId: string, events: readonly ExecutionEvent[]): DebuggerFrameState {
  const root: DebuggerFrame = {
    key: DEBUGGER_ROOT_FRAME_KEY,
    parentKey: null,
    flowId: rootFlowId,
    displayName: 'Root flow',
    depth: 0,
    status: 'active',
    startedSeq: 0,
    nodeActivity: {},
  };
  const state: DebuggerFrameState = {
    rootKey: root.key,
    activeFrameKey: root.key,
    frames: { [root.key]: root },
    order: [root.key],
  };

  for (const event of events) {
    const depth = eventDepth(event);
    if (depth < 0 || depth > MAX_DEBUGGER_SUBFLOW_DEPTH) continue;

    if (event.type === 'run:start') {
      state.activeFrameKey = root.key;
      continue;
    }

    if (event.type === 'subflow:start') {
      if (!event.subflowId || depth <= 0) continue;
      const parent = parentForStart(state, event, depth);
      const laneSuffix = event.laneIndex == null ? '' : `:lane-${event.laneIndex}`;
      const frameKey = `${parent.key}:${event.node?.nodeId ?? 'subflow'}:${event.subflowId}${laneSuffix}:seq-${event.seq}`;
      const frame: DebuggerFrame = {
        key: frameKey,
        parentKey: parent.key,
        flowId: event.subflowId,
        invokingNodeId: event.node?.nodeId,
        displayName: event.laneTitle || event.subflowName || event.subflowId,
        depth,
        laneIndex: event.laneIndex,
        laneCount: event.laneCount,
        laneTitle: event.laneTitle,
        status: 'active',
        startedSeq: event.seq,
        nodeActivity: {},
      };
      state.frames[frameKey] = frame;
      state.order.push(frameKey);
      state.activeFrameKey = frameKey;
      if (event.node?.nodeId) {
        parent.nodeActivity[event.node.nodeId] = { kind: 'active', ts: event.timestamp };
      }
      continue;
    }

    if (event.type === 'subflow:done') {
      const completed = latestMatchingFrame(state, frame =>
        frame.status === 'active'
        && frame.depth === depth
        && frame.flowId === event.subflowId
        && (event.node?.nodeId == null || frame.invokingNodeId === event.node.nodeId)
        && laneMatches(frame, event)
      );
      if (!completed) continue;
      completed.status = event.status;
      completed.endedSeq = event.seq;
      state.activeFrameKey = completed.parentKey ?? root.key;
      const parent = state.frames[completed.parentKey ?? root.key];
      if (completed.invokingNodeId && parent) {
        parent.nodeActivity[completed.invokingNodeId] = { kind: 'active', ts: event.timestamp };
      }
      continue;
    }

    const target = frameForEvent(state, event);
    state.activeFrameKey = target.key;
    const nodeId = eventNodeId(event);
    if (nodeId) {
      target.nodeActivity[nodeId] = { kind: activityKind(event), ts: event.timestamp };
    }
  }

  return state;
}

export function debuggerFramePath(state: DebuggerFrameState, frameKey: string): DebuggerFrame[] {
  const path: DebuggerFrame[] = [];
  const seen = new Set<string>();
  let current: DebuggerFrame | undefined = state.frames[frameKey];
  while (current && !seen.has(current.key) && path.length <= MAX_DEBUGGER_SUBFLOW_DEPTH) {
    path.unshift(current);
    seen.add(current.key);
    current = current.parentKey ? state.frames[current.parentKey] : undefined;
  }
  return path;
}
