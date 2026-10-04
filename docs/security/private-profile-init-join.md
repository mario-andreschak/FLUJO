# Private-profile startup join

This follow-up directly follows frozen #716, `16c5785f9e0b20290fa057d2e4d48c5330021923`. The actual installed Linux run `37178254308` completed its private-profile phase: observed fresh lock, public-default setup denial, private USER enrollment, USER v2 metadata, v2 encryption output, cold-restart lock, reauthentication and unchanged metadata. The next real filesystem MCP proxy probe failed because that server was not found or exposed. The overall production/installed smoke therefore failed; the retained receipt is `.tmp/private-installed-716-linux-build.txt`.

## Joining the unlocked startup

Locked boot settles the general backend initialization memo while deferring secret-dependent MCP/scheduler startup. Authentication starts those services through `onUnlocked()` using a separate memo. `/api/init` previously joined only the completed boot memo, so it could report success before deferred provisioning/connection finished or even after that deferred work failed.

The initialization route now joins `onUnlocked()` after its ordinary initialization completes and current encryption is unlocked. That hook shares the existing service startup memo, preserving once-only provisioning, MCP startup and scheduler arming. While encryption remains locked, the route retains its boot-only behavior and starts no secret-dependent effects. No timeout extension or effect/owner/encryption guard removal is included. Default protection retains the hook's existing no-op behavior.

Two new controls first ran against the actual #716 route with the real backend orchestration and controlled collaborators. They reproduce an early 200 while shipped-server migration is held behind a gate and a 200 despite a deferred startup failure. The corrected route waits for release and propagates failure through its existing 500 path. The locked path also has a negative effect control. The focused backend startup suite passes 16 assertions with zero skips, and eight existing lock-gate controls passed in the paired run. Receipts: `.tmp/private-init-join-predecessor.json`, `.tmp/private-init-join-final.json`, `.tmp/private-init-join-sealed.json`. These are source-level orchestration controls; MCP service/provisioning collaborators are controlled, and the workspace route wrapper is bypassed for this handler test.

## Native fixture paths and mandatory checks

The #716 Windows production job failed the helper checks and installed fixture's owned-directory guard. A native local Windows control reproduces that denial when a real owned directory is requested with a lowercase drive letter but `realpath` supplies its canonical spelling. The corrected helper admits canonical physical directory relationships and retains requested root/data directory and leaf-link checks, the immediate canonical temporary-parent constraint, exact owned-name pattern and canonical `data` child. It no longer compares canonical filesystem results with lexical requested strings. This changes only the disposable fixture's directory guard; no private reader device/inode/nanosecond/mode/UID/single-link checks are weakened. Actual Windows CI must still qualify the correction and the separate installed startup limitation.

Helper controls now run in their own mandatory production-matrix step before installed smoke. Combining native commands in one PowerShell step could otherwise let a later success replace an earlier test exit code. Workflow contract cases reject missing, late, combined, conditional or optional helper checks, and preserve the existing packed-smoke requirements, immutable actions, gate names and skip/assertion accounting.

The final Node script selection passes 59 assertions with zero skips, including 31 helper cases and the native drive-spelling control. The preceding native drive control records 30 passed / one failed before the helper correction. Changed-file ESLint and diff checks pass. No broad local typecheck/Jest, Next build, installed application or new local container ran for this follow-up; those graph and installed qualifications remain hosted/coordinator work.

## Limits

This source slice includes neither the coordinator's separate Windows stable-file platform correction nor a change to isolation defaults. Fresh combined-root CI, installed MCP readiness after private restart, operator/browser enrollment, owner/BFF authentication, migration, continuous revocation, default isolation, human exercises and independent Security reassessment remain open. The private phase's installed Linux success is retained separately from the later MCP failure and cannot establish overall A- acceptance.

Earlier local resource removals were rejected by automatic approval review with `blocked by policy`. Those scratch images/contexts and the empty diagnostic fixture directory remain; no retry or cleanup success is claimed.
