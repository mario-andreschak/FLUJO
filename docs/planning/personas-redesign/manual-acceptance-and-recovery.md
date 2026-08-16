# Persona redesign manual acceptance and recovery

This checklist is the release gate for issue #435. It records a manual run of the same ten-step journey required by browser acceptance. It does not authorize migration of production data or selection of a recovery branch.

## Run record

- Date/time:
- FLUJO commit:
- Tester:
- Reviewer:
- Operating system/browser:
- Primary workspace:
- Isolation workspace:
- Deployment/start command:
- Deployment/stop command:
- Deployment/restart command:
- Evidence location:
- Result: [ ] Pass [ ] Fail [ ] Blocked

The implementation baseline observed while this checklist was added was `6ce83ccfc80a3d00e49e386dc00f36f0105c725b`. Record the commit actually tested above; never assume the observed baseline is still current.

## Required approvals before a run

- [ ] The implementation baseline is clean, reproducible, and approved.
- [ ] All Persona dependency issues selected for this release are accepted.
- [ ] The supported locales and fallback policy are recorded.
- [ ] The Persona list/detail performance budgets and fixture sizes are recorded.
- [ ] The browser-acceptance framework and CI job are approved.
- [ ] The rollout flag and acceptance authority are recorded.
- [ ] The retention policy for forgotten Memory, deleted Tasks, tombstones, and backups is recorded.
- [ ] A recovery branch has been selected and its commit verified.

Two recovery candidates currently exist. A release owner must select exactly one; this checklist deliberately does not choose for them.

| Candidate | Observed commit | Approved |
| --- | --- | --- |
| `origin/codex/personas-simple-flujo-ui` | `9f48f65c68b35b5b3ed4e386c59a2c13f00a84e1` | [ ] |
| `origin/codex/personas-solid-foundation-snapshot` | `b11603865771ace6d49346945c6595edfe561cfa` | [ ] |

- Approved recovery branch:
- Approved recovery commit:
- Retain until:
- Approved by:

Stop if neither branch/commit is approved, if the ref moved unexpectedly, or if the recovery commit cannot start and read the acceptance backup.

## Prerequisites and fixtures

Create two disposable workspaces, A and B. Give records recognizable names prefixed with the run ID; do not use internal IDs as labels or test evidence.

Workspace A must contain:

- one Role with a prompt and at least two suggested Apps;
- one model-ready Core Flow;
- one shared Behavior Flow that invokes a deterministic test capability;
- one granted deterministic App;
- one Persona;
- one Memory;
- one saved Task;
- enough History to exercise filtering;
- a long Persona/Task name and long translated copy for reflow checks.

Workspace B must contain similarly named decoy records that must never appear in workspace A.

Also prepare:

- an App test double whose invocation has semantic, user-visible evidence;
- a Behavior test double whose invocation has semantic evidence;
- a controlled long-running Activity so a Task can be queued while the Persona is busy;
- the approved application stop/start mechanism;
- a clean browser profile;
- screen-reader tooling;
- a narrow viewport (320 CSS px minimum) and 200% zoom;
- storage for the downloaded workspace backup and evidence.

Do not use real secrets or production data. Treat every workspace backup as sensitive.

## Recovery point and backup exercise

Complete this section before any migration or acceptance mutation.

1. Open the active workspace and navigate to **Settings → Backup & Restore**.
2. Under **Create Backup**, select every category required for this acceptance fixture and choose **Create Backup**.
3. Save the generated `flujo-backup-<timestamp>.zip` outside the workspace. Record its path, size, creation time, and SHA-256.
4. In a fresh disposable workspace, return to **Settings → Backup & Restore**.
5. Under **Restore from Backup**, choose the ZIP, select the same categories, choose **Restore from Backup**, review the warning, and confirm.
6. Reload the workspace and verify the restored records, relationships, configuration, and workspace placement.
7. Verify that nothing from workspace B appeared in the restored workspace.
8. Keep the original backup unchanged until rollout acceptance expires.

Backup evidence:

- Backup file:
- SHA-256:
- Size:
- Restore workspace:
- Restored record/relationship comparison:
- Isolation result:
- Reviewer:

The supported product workflow uses the Settings UI backed by `POST /api/backup` and `POST /api/restore`. Do not substitute direct filesystem copying. If the selectable categories do not cover the Persona fixture required by the release, mark this gate blocked; do not claim the backup exercise passed.

## Ten-step journey

For every step, capture a screenshot or video segment plus any semantic evidence named below. Primary UI must not require raw IDs, URIs, JSON, hashes, revision IDs, mailbox/lease terms, or runtime error text.

### 1. Create a Role

- [ ] Create a Role with a recognizable name, prompt, and suggested Apps.
- [ ] The Role appears by name and description.
- [ ] Cancel/retry does not leave an unreachable partial Role.
- [ ] Workspace B cannot see the Role.

Evidence/result:

### 2. Create a Persona

- [ ] Start the Persona wizard from the primary Personas surface.
- [ ] Choose the Role, enter name/mission, and complete the wizard.
- [ ] Keyboard focus advances and returns predictably on cancel.
- [ ] A failed or cancelled step leaves no unreachable partial Persona.

Evidence/result:

### 3. Configure the Core Flow

- [ ] Choose the model-ready Core Flow using recognizable Flow metadata.
- [ ] Missing/incompatible model configuration produces an actionable localized error.
- [ ] No internal Flow ID is needed or displayed in the primary path.

Evidence/result:

### 4. Add and copy Behavior

- [ ] Add the shared Behavior Flow.
- [ ] Make a Persona-owned copy.
- [ ] Shared source and Persona-owned immutable revision are visually distinct.
- [ ] Editing a new revision does not change prior History evidence.

Evidence/result:

### 5. Accept and replace Apps

- [ ] Review Role-matched Apps by name/provider/capability.
- [ ] Accept one and replace one.
- [ ] Review the capability/privacy impact.
- [ ] A revoked or foreign-workspace App cannot launch.

Evidence/result:

### 6. Manage Memory

- [ ] Add a Memory in plain language.
- [ ] Correct it and verify the earlier version remains in history.
- [ ] Pin and unpin it.
- [ ] Open the Forget dialog, cancel once, reopen, and confirm.
- [ ] The dialog explains future-use, history/recovery, and core-memory effects.
- [ ] Focus returns to a deterministic control after close.

Evidence/result:

### 7. Chat through Core, Behavior, and App

- [ ] Start a conversation from the Persona.
- [ ] Complete an interaction that causes Core to invoke the Behavior and the granted App.
- [ ] Capture semantic evidence for both invocations.
- [ ] Conversation attribution remains attached to the Persona without exposing internal IDs.

Evidence/result:

### 8. Queue a saved Task while busy

- [ ] Start the controlled long-running Activity.
- [ ] Assign the saved Task while the Persona is busy.
- [ ] The UI announces that the Task is queued and shows its waiting state.
- [ ] Repeating the request does not dispatch a duplicate.
- [ ] Queue status/order is understandable without mailbox or lease terminology.

Evidence/result:

### 9. Restart and resume

Use only the approved stop/start commands recorded in the run record.

1. While the Activity/Task state is durable and observable, record current user-visible state.
2. Stop FLUJO gracefully with the approved operator command.
3. Confirm the old process is no longer serving requests.
4. Start FLUJO with the approved operator command, using the same workspace.
5. Reopen the Persona and wait through supported UI state changes.
6. Verify attribution, queue order, and workspace identity are preserved.
7. Verify the active/resumable work safely resumes or presents an actionable retry state.
8. Verify the queued Task eventually starts exactly once.
9. Verify no stale pre-restart worker can complete the same work.

- [ ] Restart command and timestamps recorded.
- [ ] Resume result recorded.
- [ ] Exactly-once Task evidence recorded.
- [ ] Workspace B remains isolated.

Evidence/result:

If this deployment has no approved stop/start procedure, mark the gate blocked. Do not invent a process-kill command during acceptance.

### 10. Review History, export, and deletion preview

- [ ] Open **History** and filter by type, outcome, and date.
- [ ] Entries show safe summaries, timestamps, Conversation/Task links where available, and safe advanced evidence.
- [ ] History shows no raw Activity IDs, revision hashes, leases, mailbox payloads, or internal errors.
- [ ] Preview a Persona configuration export.
- [ ] The preview states that runtime/private workspace data is excluded.
- [ ] Inspect the manifest and verify Conversations, Activities/History runtime records, App grants, mailbox/leases, secrets, and unrelated workspace data are absent.
- [ ] Separately explain that a workspace backup may contain sensitive data and covers only the active workspace.
- [ ] Open Persona deletion preview without confirming deletion.
- [ ] The preview lists dependent records, quiescence, anonymization/tombstone behavior, retained recovery data, and backup-expiry implications.
- [ ] Change dependent state and verify stale preview confirmation is rejected.
- [ ] Workspace B cannot preview/export/delete workspace A records.

Evidence/result:

## Migration and repair checks

Run only against immutable disposable fixtures after the recovery exercise passes.

- [ ] Each supported historical Persona/Role/Behavior/App/Memory/Task/Activity shape migrates.
- [ ] Mixed and partially migrated workspaces resume idempotently.
- [ ] Before/after counts, stable IDs, relationships, revision hashes, attribution, workspace placement, and core-memory bindings match.
- [ ] Unsupported/corrupt records fail closed with a repair report.
- [ ] Interruption at every documented checkpoint can rerun to completion.
- [ ] A failed migration restores from the verified backup/recovery point without record loss.
- [ ] Original data and recovery artifacts remain retained.

Evidence/result:

## Privacy and workspace isolation

Repeat list, detail, conversation, scheduler/runtime callback, App launch, History, export, backup, restore, and deletion-preview checks in both workspaces.

- [ ] No workspace A record is visible or mutable from workspace B.
- [ ] URLs, caches, reloads, and back/forward navigation preserve workspace fencing.
- [ ] Configuration export contains allowlisted configuration only.
- [ ] Workspace backup is labeled sensitive and bound to one workspace.
- [ ] Deletion affects only owned records and documented tombstones.
- [ ] Logs/screenshots contain no secrets or private payloads.

Evidence/result:

## Accessibility and responsive checks

- [ ] Complete the journey with keyboard only.
- [ ] Headings, landmarks, tabs, fields, dialogs, errors, and status updates have useful accessible names/semantics.
- [ ] Dialog open/close focus is deterministic.
- [ ] Busy, queued, started, completed, interrupted, and failed changes are announced without excessive repetition.
- [ ] No serious or critical automated accessibility violation remains.
- [ ] Screen-reader smoke test passes.
- [ ] At 320 CSS px and at 200% zoom, content reflows and all actions remain reachable.
- [ ] Long translations and user content do not hide controls or force horizontal-page scrolling.
- [ ] Status, disabled, selected, focus, and error treatments meet the approved contrast target.

Evidence/result:

## Performance gates

Record the approved budgets before measuring.

| Metric | Fixture size | Budget | Result | Pass |
| --- | ---: | ---: | ---: | --- |
| Persona list API latency |  |  |  | [ ] |
| Persona detail API latency |  |  |  | [ ] |
| List payload size |  |  |  | [ ] |
| Detail payload size |  |  |  | [ ] |
| Initial request count |  |  |  | [ ] |
| Initial render |  |  |  | [ ] |
| Interaction responsiveness |  |  |  | [ ] |

- [ ] History and Memory are bounded/paginated at the agreed fixture size.
- [ ] Detail-only data is not loaded on the list path.
- [ ] Performance evidence includes correctness assertions.

## Rollback triggers and procedure

Immediately stop rollout on any of these conditions:

- migration parse failure, unsupported/corrupt record without a repair report, or record/reference mismatch;
- cross-workspace visibility or mutation;
- duplicate or lost work after restart;
- configuration export containing forbidden runtime/private data;
- deletion-preview race or deletion beyond documented ownership;
- serious/critical accessibility failure;
- approved performance-budget breach;
- inability to restore the verified backup or start the approved recovery commit.

Rollback record:

1. Stop mutations and preserve logs/evidence.
2. Record the failing commit, workspace, time, and trigger.
3. Do not delete or rewrite the original workspace, backup, snapshot, or recovery refs.
4. Restore only into a fresh disposable workspace through **Settings → Backup & Restore** first.
5. Verify counts, relationships, attribution, and workspace placement.
6. With release-owner approval, redeploy the exact approved recovery commit.
7. Re-run isolation and smoke checks before allowing further use.

- Trigger:
- Time:
- Failing commit:
- Backup used:
- Recovery branch/commit:
- Restore verification:
- Owner approval:

## Final sign-off

All fields require explicit evidence. A blank or blocked gate is not a pass.

- Functional acceptance: [ ] Pass [ ] Fail — Reviewer/date:
- Migration and repair: [ ] Pass [ ] Fail — Reviewer/date:
- Privacy and isolation: [ ] Pass [ ] Fail — Reviewer/date:
- Accessibility/responsive: [ ] Pass [ ] Fail — Reviewer/date:
- Performance: [ ] Pass [ ] Fail — Reviewer/date:
- Backup/restore and recovery: [ ] Pass [ ] Fail — Reviewer/date:
- Browser CI journey: [ ] Pass [ ] Fail — Run URL:
- Release authority: [ ] Approved [ ] Rejected — Name/date:
