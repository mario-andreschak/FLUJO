// FLUJO's own lint rules. Each one exists because agents (or people) made the
// same mistake more than once. See "Corrections become checks" in AGENTS.md.
import disableNeedsReason from './rules/disable-needs-reason.mjs';
import mcpFeatureDefaults from './rules/mcp-feature-defaults.mjs';
import noAdhocStartupErrorMatch from './rules/no-adhoc-startup-error-match.mjs';
import noDoubleCast from './rules/no-double-cast.mjs';
import noHandRolledFileRetry from './rules/no-hand-rolled-file-retry.mjs';
import noNodeVm from './rules/no-node-vm.mjs';
import noRawTimers from './rules/no-raw-timers.mjs';
import noSyncFs from './rules/no-sync-fs.mjs';
import noWorkaroundComment from './rules/no-workaround-comment.mjs';
import singleToolApprovalGate from './rules/single-tool-approval-gate.mjs';

export default {
  meta: { name: 'eslint-plugin-flujo' },
  rules: {
    'disable-needs-reason': disableNeedsReason,
    'mcp-feature-defaults': mcpFeatureDefaults,
    'no-adhoc-startup-error-match': noAdhocStartupErrorMatch,
    'no-double-cast': noDoubleCast,
    'no-hand-rolled-file-retry': noHandRolledFileRetry,
    'no-node-vm': noNodeVm,
    'no-raw-timers': noRawTimers,
    'no-sync-fs': noSyncFs,
    'no-workaround-comment': noWorkaroundComment,
    'single-tool-approval-gate': singleToolApprovalGate,
  },
};
