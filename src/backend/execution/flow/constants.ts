/**
 * Shared execution-core constants.
 *
 * Kept in a dependency-free module so both runFlow (the execution keystone) and
 * the handoff-description synthesizer (issue #38, Item A) can import the same
 * value without creating an import cycle through the node/engine graph.
 */

/**
 * Hard ceiling on subflow-call nesting (re-entrancy guard). A SubflowNode runs
 * its child at runDepth + 1; runFlow refuses to start a run past this depth so
 * a flow that (directly or indirectly) calls itself cannot recurse forever.
 *
 * The same ceiling bounds how deep the handoff-description synthesizer walks
 * nested subflows when summarising a handoff target (issue #38, Q2).
 */
export const MAX_SUBFLOW_DEPTH = 8;
