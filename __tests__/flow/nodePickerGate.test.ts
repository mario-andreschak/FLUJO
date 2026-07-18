/**
 * Issue #133 (bonus bug): the "Select Node Type" popup appeared while the user
 * was drawing an edge between two handles. `shouldOpenNodePicker` is the pure
 * gate that `onConnectEnd` now delegates to; these tests pin the exact
 * conditions under which the picker may open, so the stray-popup regression
 * cannot come back.
 */
import { shouldOpenNodePicker, NodePickerGateArgs } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/nodePickerGate';

// A create-capable pane drop from a Process node's bottom (source) handle.
const base: NodePickerGateArgs = {
  fromNodeType: 'process',
  fromHandleType: 'source',
  fromHandleId: 'process-bottom',
  landedOnHandle: false,
  droppedOnPane: true,
  subflowHasOutgoing: false,
};

describe('shouldOpenNodePicker', () => {
  it('opens for a genuine drop on the empty pane from a source handle', () => {
    expect(shouldOpenNodePicker(base)).toBe(true);
  });

  it('THE BUG: never opens when the drag ended on a handle (onConnect owns it)', () => {
    // Even if the drop coordinates happen to resolve to the pane, a real
    // handle→handle connection must not trigger the picker.
    expect(shouldOpenNodePicker({ ...base, landedOnHandle: true })).toBe(false);
    expect(shouldOpenNodePicker({ ...base, landedOnHandle: true, droppedOnPane: true })).toBe(false);
  });

  it('never opens when the drop is not on the pane (node body / overlay / control)', () => {
    expect(shouldOpenNodePicker({ ...base, droppedOnPane: false })).toBe(false);
  });

  it('never opens without a usable source handle id', () => {
    expect(shouldOpenNodePicker({ ...base, fromHandleId: null })).toBe(false);
    expect(shouldOpenNodePicker({ ...base, fromHandleId: undefined })).toBe(false);
  });

  it('does not open for a top (target-type) flow handle — those only convert edges to bidirectional', () => {
    expect(
      shouldOpenNodePicker({ ...base, fromHandleType: 'target', fromHandleId: 'process-top' })
    ).toBe(false);
  });

  it('DOES open for a target-type MCP handle — MCP wiring is non-directional', () => {
    expect(
      shouldOpenNodePicker({
        ...base,
        fromNodeType: 'mcp',
        fromHandleType: 'target',
        fromHandleId: 'process-left-mcp',
      })
    ).toBe(true);
  });

  it('does not open for a subflow source that already has an outgoing successor', () => {
    expect(
      shouldOpenNodePicker({
        ...base,
        fromNodeType: 'subflow',
        fromHandleId: 'subflow-bottom',
        subflowHasOutgoing: true,
      })
    ).toBe(false);
  });

  it('opens for a subflow source with no outgoing successor yet', () => {
    expect(
      shouldOpenNodePicker({
        ...base,
        fromNodeType: 'subflow',
        fromHandleId: 'subflow-bottom',
        subflowHasOutgoing: false,
      })
    ).toBe(true);
  });

  it('the handle gate wins over every downstream allowance (landedOnHandle short-circuits)', () => {
    // A subflow with capacity + valid source, but the edge landed on a handle.
    expect(
      shouldOpenNodePicker({
        ...base,
        fromNodeType: 'subflow',
        fromHandleId: 'subflow-bottom',
        subflowHasOutgoing: false,
        landedOnHandle: true,
      })
    ).toBe(false);
  });
});
