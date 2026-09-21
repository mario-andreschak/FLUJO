# Persona recovery implementation design

Status: implemented in the September 2026 audit and under integration verification; **not release-certified**. Capture, the versioned manifest, record/artifact preflight, frozen restore, atomic workspace publication, local routes and localized Settings actions are present. Backend, component, route and real-process interruption tests pass at the checkpoints recorded in the audit. The complete Settings round trip, deliberate reconnection/fresh Activity and final-source endurance checks remain acceptance work.

The first browser capture found a conversation projection still marked running after its Activity and dispatch had failed. Capture now permits that provably terminal history while rejecting live authority. The same fixture contained an out-of-order historical log entry. Production transcript projection already supports file-order history and legacy sequence sentinels: recovery preserves those bytes, counts the anomaly in its manifest and discloses it in both previews. It does not repair the sequence or certify it as a resumable cursor.

## Product contract

Settings → Backup & Restore needs a **Persona recovery** category, distinct from the existing configuration export. It covers the selected workspace, including private Memory, saved Tasks/goals and conversation/history evidence. The preview must show included categories, omitted credentials/external files, source workspace, timestamp, and record counts before download. A partial archive must never be called a successful recovery point.

Restore creates a new, isolated workspace in one transaction. It does not merge into or overwrite a populated workspace. The restored Personas remain disabled, ongoing goals remain paused, and old work never runs automatically. The owner reviews model/App connections and explicitly enables future work. A recovery archive may contain sensitive content even when account credentials are excluded.

## Data inventory

Use the fixed `ENDURING_AGENT_COLLECTIONS` inventory rather than a caller-supplied path. Preserve:

- Role definitions and all referenced immutable Role versions;
- Personas, drafts, composition, owned authoring Flows and immutable Behavior revisions/bindings;
- Memory, correction/conflict relationships, important-memory bindings and saved Tasks/goals;
- Activities, their frozen Core/instruction context, conversations and specialist-call pins;
- improvement proposals, evaluations, outcome metrics, maintenance history and rollback relationships;
- deletion tombstones and documented retained attribution;
- owned Persona home files through a link-safe bounded file inventory.

The archive must distinguish immutable historical evidence from executable authority. Mailbox/dispatch/lease/recovery receipts and runtime event logs may be retained as original recovery evidence; they must not be installed as live work queues, leases or pending projection outboxes in the restored workspace. Merely changing the Persona's learning level does not disable execution. Likewise, setting a goal to paused is insufficient if an old pending dispatch remains live.

Flow dependencies need an explicit plan: include shared/owned Flows and their required versions, preserve selected model and App references, and disclose which connections need reconnection. Do not copy arbitrary account caches, Codex login state, worker bootstrap secrets, browser profiles, external filesystem roots or installed executable dependencies as an incidental consequence of backing up Personas. If credential-bearing categories are eventually supported, make that a separate explicit selection with its own security and portability contract.

## Capture boundary

1. Require local, unlocked, explicitly workspace-scoped authority. Reject workers or unsupported capture contexts.
2. Use `withWorkspaceRecoveryCapture` outside any `withWorkspaceMutation` call. Existing `runInWriteChain` admission covers complete Persona/Role domain mutations and nested writes. The wrapper drains the local gate before holding filesystem admission and draining registered writers in other processes. Calling it inside a mutation is rejected.
3. Inspect live runtime authority and unfinished provisioning/deletion, and reject unsupported in-flight states with a user-facing retry instruction. All processes accessing the workspace must implement this registration protocol. Older/unregistered processes and external writes bypass it; the archive must not claim filesystem-wide coherence or protection from arbitrary external writers. Persona home-file capture still needs the link/change checks and active-work rejection below.
4. Read strict, bounded, link-free records and files into immutable capture inputs. Fail the whole capture on malformed/unsupported records, unsafe links, duplicate IDs or a changing file. Do not reuse the legacy backup route's skip-and-continue behavior.
5. Validate the complete reference graph and produce the manifest while the boundary is held. Release promptly; compress and download the immutable inputs after release.

The worker snapshot implementation provides useful link/ZIP/size checks, but its credential transfer and bootstrap restore are a different product contract and must not be reused wholesale.

## Versioned manifest and preflight

Use a dedicated format discriminator and version, independent of legacy `backup-info.json` version 1.0 and the worker snapshot format. Record the source workspace, layout version, application/schema compatibility, generation, capture time, privacy exclusions, per-kind counts, per-file lengths and SHA-256 values.

Before any destination write:

1. Inspect ZIP structure before decompression. Reject duplicate or case-folded paths, traversal, links, path conflicts, unknown entries, excessive entry counts, excessive declared/actual uncompressed sizes and unsupported ZIP features. JSZip normalization alone is not sufficient.
2. Require the manifest's source identity to match all workspace-bound operational records. Preserve source identity within immutable historical provenance; do not recursively rewrite every string matching the old workspace name.
3. Parse supported record versions through the existing explicit migration registry. Produce a repair report for unsupported/corrupt records. Do not silently drop unknown fields or records to make restore appear successful.
4. Validate Role/version/Persona, binding/revision/Flow, Memory/core/correction, Task/goal/dependency, Activity/conversation/context and improvement/rollback ownership relationships. Account for documented retention and deleted-Persona tombstones instead of assuming every historical reference must still have a live owner.
5. Verify immutable content hashes and IDs using the same legacy/current hash rules as the runtime. Byte-preserve original revision evidence; do not make migrated fields change what an old Activity claims it executed.
6. Build a restore plan with deterministic changes: disabled Personas, paused nonterminal goals, cleared pending controls/rounds, no live leases/dispatches/mailbox, no resumed worker authority, no implicitly granted Apps. Keep the original archive and a bounded change report.

## Atomic publication

Stage the validated plan beneath an internal, non-workspace name on the same filesystem as `workspaces/`. Internal staging names must not be discoverable by `listWorkspaces`, scheduled work or ordinary route selection. Use private file permissions, exclusive creation, safe IDs and link-free containment checks. Rebuild derived indexes/caches from the validated records; do not import source process cache generations as authority.

Hold a destination allocation lock, reject existing/case-equivalent destinations, and atomically publish the complete staged directory. Never rename or delete an existing user workspace. A failure before publication leaves no selectable destination; a crash after publication leaves a complete frozen workspace. Cleanup may remove only a staging directory whose identity and containment are verified. The selected source workspace is never modified by restore.

After publication, return the new workspace name, record comparison and reconnection/resumption instructions. The UI switches only when the user chooses to open it. A second submission with the same restore identity must report the existing completed result or a conflict rather than create two workspaces.

## Required verification

- Actual Settings download/upload round trip with the complete two-workspace fixture; compare IDs, counts, immutable hashes, Memory history, Tasks, conversation attribution and owned/shared Flow relationships.
- Reject malformed ZIPs, hash tampering, future versions, partial graphs, duplicate IDs, foreign workspace owners and corrupt migration inputs before publication.
- Interrupt capture and every staging/publication checkpoint; retry without a partial selectable workspace, duplicate restoration or source modification.
- Restore while dispatch/goal/maintenance controllers are running. Prove zero automatic model turns, App effects, queued work or stale lease completions, including across process restart.
- Reconnect and deliberately enable a restored Persona, then verify one new Activity uses restored configuration and Memory while old Activity evidence remains unchanged.
- Verify workspace B is absent from A's archive and unchanged by restore, including deliberately duplicated Persona/Role IDs.
- Preserve the downloaded original as evidence, with SHA-256 and size. Configuration export remains separately tested for exclusion of private/runtime data.

Passing this plan's implementation tests still does not provide a release-owner recovery-branch approval or exact-release sign-off. Those remain separate fields in the manual acceptance checklist.

## Implemented limits and persistence details

- Version 1 accepts ZIP32 only: at most 60,000 members, 64 MiB per ordinary file, 100 MiB compressed and 512 MiB expanded totals. The compressed limit matches Next's existing 100 MiB proxy buffer, which its local documentation says otherwise forwards a truncated body. A shared server/UI constant prevents creating an archive that cannot be uploaded intact. Model-turn gzip payloads also consume the expanded budget. Limits are checked before allocation/inflation; paths, links, aliases, exact source file identities and directory inventories are checked before publication.
- The immediately previous source ZIP may exceed the ordinary 64 MiB file limit, up to the archive limit, because it is retained as opaque evidence and never recursively inflated. It still consumes the common 512 MiB total. Repeated recoveries can grow the retained archive; exceeding the total fails the entire next capture rather than omitting history.
- All workspace Flows and their version history are captured because callable Flow selection can be dynamic. Standalone unrelated chats and model/App connection configuration are excluded. User-authored Flow fields and Persona home files can still contain secrets; the download is explicitly unencrypted.
- Execution leases, running dispatches, active maintenance, pending provisioning, incomplete deletion and uncommitted runtime recovery prevent capture. Historical model archives may still say running after a crash; they are evidence, not worker authority.
- Restored Personas are disabled with learning locked; nonterminal goals pause, unfinished Activities/maintenance cancel, pending goal controls clear, and App grants/mailbox/dispatch/lease/call-pin records remain only in the exact retained source ZIP. Conversations lose session/resume state and become read-only. Derived summaries and runtime-event logs are not installed as live projections.
- Anonymous deletion origins retain their source hashes and are projected only when an identity is subsequently requested in the restored workspace. Empty, corrupt, missing-after-restore, linked or conflicting origin records fail closed. This prevents deterministic factory resurrection across successive restores without recovering deleted identities from anonymous hashes.
- Create/rename/delete and recovery publication share the workspace namespace lock. A hidden sibling staging directory is never a selectable workspace. A repeated submission with the same archive/destination/preview token returns the completed workspace. Fault-injection exceptions clean their verified staging directory; a killed process can leave a hidden orphan staging directory. Automatic orphan cleanup is not implemented and should not be claimed.
- Ordinary saved backups, including the retained source ZIP, are not rewritten by later Persona deletion. The existing backup-retention policy applies; no automatic expiration or immediate purge was added by this work.
