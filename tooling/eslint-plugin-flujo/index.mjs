// FLUJO's own lint rules. Each one exists because agents (or people) made the
// same mistake more than once. See "Corrections become checks" in AGENTS.md.
import disableNeedsReason from './rules/disable-needs-reason.mjs';
import noDoubleCast from './rules/no-double-cast.mjs';
import noRawTimers from './rules/no-raw-timers.mjs';
import noSyncFs from './rules/no-sync-fs.mjs';
import noWorkaroundComment from './rules/no-workaround-comment.mjs';

export default {
  meta: { name: 'eslint-plugin-flujo' },
  rules: {
    'disable-needs-reason': disableNeedsReason,
    'no-double-cast': noDoubleCast,
    'no-raw-timers': noRawTimers,
    'no-sync-fs': noSyncFs,
    'no-workaround-comment': noWorkaroundComment,
  },
};
