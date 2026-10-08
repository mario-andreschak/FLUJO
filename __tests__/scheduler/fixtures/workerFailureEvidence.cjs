'use strict';
const statuses = new Set(['completed', 'error', 'skipped', 'needs_approval', 'capped']);
const reasons = new Set(['worker-not-ready', 'recovery-not-configured', 'no-local-provenance', 'invalid-provenance',
  'worker-authority-changed', 'generation-changed', 'definition-changed', 'not-opted-in', 'unsupported-plan',
  'paused', 'disabled', 'retired', 'unresolved-admission', 'already-accounted', 'eligible']);
const codes = new Set(['static_tool_cancelled', 'static_mcp_tool_error', 'static_mcp_timeout', 'static_mcp_service_error']);
function category(value, detailCode) {
  if (codes.has(detailCode)) return detailCode;
  const text = typeof value === 'string' ? value.slice(0, 2048) : '';
  if (!text) return 'none';
  if (/HOST_(?:CONSENT_REQUIRED|POLICY_INVALID|UNAVAILABLE)/.test(text)) return 'host-authority';
  if (/ISOLATION_[A-Z_]+/.test(text)) return 'isolation-authority';
  if (/OWNER_[A-Z_]+/.test(text)) return 'owner-authority';
  if (/encryption locked/i.test(text)) return 'encryption-locked';
  if (/Worker schedule|Schedule changed before|local recovery admission/i.test(text)) return 'schedule-admission';
  if (/approval/i.test(text)) return 'approval';
  if (/timeout|timed out/i.test(text)) return 'timeout';
  return 'other';
}
/** Closed categories only; never emit raw errors, arguments, IDs or output. */
function projectWorkerFailureEvidence(rows, planId) {
  const row = Array.isArray(rows) && rows.find(candidate => candidate.execution?.id === planId);
  if (!row) return { plan: 'missing' };
  const status = row.status || {};
  const run = row.lastRun;
  return { plan: 'present', armed: status.armed === true, running: status.running === true,
    recoveryPending: Boolean(status.workerRecovery?.pending),
    recoveryReason: reasons.has(status.workerRecovery?.reason) ? status.workerRecovery.reason : 'unknown',
    nextRun: typeof status.nextRun === 'string' ? 'present' : 'absent',
    triggerFailure: category(status.lastTriggerError),
    lastRun: run ? (statuses.has(run.status) ? run.status : 'unknown') : 'absent',
    terminal: Boolean(run?.finishedAt),
    runFailure: category(run?.error, run?.errorDetails?.code) };
}
module.exports = { projectWorkerFailureEvidence };
