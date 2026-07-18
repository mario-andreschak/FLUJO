/**
 * Gate for the "Select Node Type" popup that can open when a connection drag
 * ends (`onConnectEnd`).
 *
 * Issue #133 (bonus bug): the popup "randomly" appeared while the user was
 * drawing an edge between two handles. Root cause: the drop was classified as
 * "landed on the empty pane" using `event.target.classList.contains(
 * 'react-flow__pane')`, which misfires whenever the pointer is released over a
 * child/overlay element (or slightly off a handle). When a real edge was (or
 * could be) formed on a handle, `onConnect` already owns that gesture and the
 * popup must stay closed.
 *
 * This module isolates the decision as a pure, side-effect-free function so it
 * can be unit-tested without a live ReactFlow/DOM, and so the brittle detection
 * lives in exactly one place.
 */
import { isMcpHandle } from './connectionRules';

export interface NodePickerGateArgs {
  /** `connectionState.fromNode?.type` — the source node's type. */
  fromNodeType?: string | null;
  /** `connectionState.fromHandle?.type` — 'source' (bottom) or 'target' (top). */
  fromHandleType?: 'source' | 'target' | null;
  /** `connectionState.fromHandle?.id` — the source handle id. */
  fromHandleId?: string | null;
  /**
   * True when the drag ended on an actual handle
   * (`connectionState.toHandle` is set). When true, `onConnect` owns the
   * gesture and the picker must not open.
   */
  landedOnHandle: boolean;
  /**
   * True when the drop target resolves to the empty ReactFlow pane. Callers
   * should compute this with `.closest('.react-flow__pane')` (robust to
   * overlay/child targets) rather than a bare `classList.contains` check.
   */
  droppedOnPane: boolean;
  /**
   * True when the source is a subflow node that already has an outgoing
   * successor. A subflow has a single outgoing path, so it must not offer to
   * create a second successor via the pane-drop picker.
   */
  subflowHasOutgoing: boolean;
}

/**
 * Decide whether a `onConnectEnd` drop should open the "Select Node Type"
 * picker. Returns `true` ONLY for a genuine drop on the empty canvas from a
 * create-capable source handle — never while a handle→handle edge is being
 * (or was just) drawn.
 */
export function shouldOpenNodePicker(args: NodePickerGateArgs): boolean {
  const {
    fromNodeType,
    fromHandleType,
    fromHandleId,
    landedOnHandle,
    droppedOnPane,
    subflowHasOutgoing,
  } = args;

  // A handle→handle edge is (or could be) being drawn — `onConnect` owns it.
  // This is the primary fix for the stray-popup bug: releasing over a handle
  // no longer opens the picker regardless of what `event.target` happens to be.
  if (landedOnHandle) {
    return false;
  }

  // The picker is only meaningful when the connection is dropped on empty
  // canvas. Anything else (a node body, an overlay, a control) is a no-op.
  if (!droppedOnPane) {
    return false;
  }

  // No usable source handle → nothing to auto-connect the new node from.
  if (!fromHandleId) {
    return false;
  }

  // Drags starting on a top (target-type) flow handle can only convert an
  // existing edge to bidirectional (see `onConnect`); dropping one on the pane
  // must not offer to create a node that would hang off a backwards edge.
  // MCP handles are exempt: MCP wiring is non-directional.
  if (fromHandleType === 'target' && !isMcpHandle(fromHandleId)) {
    return false;
  }

  // A subflow has a single outgoing path — once it has one, dropping on the
  // pane must not offer to create a second successor.
  if (fromNodeType === 'subflow' && fromHandleType === 'source' && subflowHasOutgoing) {
    return false;
  }

  return true;
}
