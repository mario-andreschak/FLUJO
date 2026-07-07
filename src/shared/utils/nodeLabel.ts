/**
 * FlowBuilder node auto-naming (issue #38, Item C).
 *
 * A Process node adopts its bound model's display name and an MCP node adopts
 * its bound server's name — but only until the user gives the node a name of
 * their own. Once the user edits the Node Label field we set
 * `properties.nameIsCustom = true` and never touch the label automatically
 * again.
 *
 * The previous behaviour only auto-set the label when it still equalled the
 * hard-coded default ('Process Node' / 'MCP Node'), so a second model switch
 * never updated it, and MCP nodes never auto-named at all. This helper is the
 * single source of truth for that decision, shared by the Process and MCP
 * property modals and unit-tested independently of React.
 */
export interface ResolveAutoNodeLabelParams {
  /** The node's current label. */
  currentLabel?: string;
  /** True once the user has manually edited the label (persisted on the node). */
  nameIsCustom?: boolean;
  /** The node's factory default label, e.g. 'Process Node' or 'MCP Node'. */
  defaultLabel: string;
  /**
   * The label that WOULD have been auto-applied for the previously-bound
   * model/server. Lets us recognise a still-auto label on flows saved before
   * `nameIsCustom` existed (back-compat), so re-binding correctly re-labels.
   */
  previousAutoLabel?: string;
  /** The label to auto-apply for the newly-bound model/server. */
  nextAutoLabel: string;
}

/**
 * Decide what a node's label should become when its bound model/server changes.
 * Returns `nextAutoLabel` when the current label is still auto-derived, and the
 * user's own `currentLabel` when they have customised it.
 */
export function resolveAutoNodeLabel({
  currentLabel,
  nameIsCustom,
  defaultLabel,
  previousAutoLabel,
  nextAutoLabel,
}: ResolveAutoNodeLabelParams): string {
  // The explicit flag always wins once set — never clobber a user's chosen name.
  if (nameIsCustom === true) {
    return currentLabel && currentLabel.length > 0 ? currentLabel : nextAutoLabel;
  }

  // Back-compat heuristic for nodes saved before the flag existed: a label is
  // "auto" when it is empty, still the factory default, or equal to the name we
  // last auto-applied. Anything else is treated as a deliberate user name.
  const isAuto =
    !currentLabel ||
    currentLabel.length === 0 ||
    currentLabel === defaultLabel ||
    (previousAutoLabel !== undefined &&
      previousAutoLabel.length > 0 &&
      currentLabel === previousAutoLabel);

  return isAuto ? nextAutoLabel : currentLabel;
}
