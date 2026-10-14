# Independent source operator upgrade and rollback for #570

The independent automated operator consumes separately pinned and built source
directories through the actual `scripts/launch-next.mjs start` command. It
initializes a private USER-encrypted installation on 3.46.2, diagnoses a failed
schedule, captures an encrypted complete backup, upgrades to 3.46.3, restores
the candidate profile and rolls back using the compatible baseline snapshot.
This advances the existing operator criterion without requiring a human-only
exercise. It does not qualify published npm packages or installer assets.

[Frozen receipt](evidence/operator-upgrade-570-2026-10-14/receipt.json),
[baseline build](evidence/operator-upgrade-570-2026-10-14/baseline-build.json),
[candidate build](evidence/operator-upgrade-570-2026-10-14/candidate-build.json).
The source pins are `320347356891aa1c24e0f2f9ce12719317e58bde` (3.46.2) and
`c6bd536c43a36a6e0571890dadf9da5846d08def` (3.46.3). Their independently
recorded source inputs, emitted bytes, build IDs and receipt hashes remain
separate from the test equipment and this evidence commit.

The fixture has two namespaces, hidden installation state, an independently
stored private owner policy/passphrase and live/revoked owner sessions. Full
stopped baseline and candidate backups contain 59 and 60 regular-file members.
Digest/key corruption and interrupted staging refuse publication. Verified
staging restores the complete selected snapshot to its original canonical paths
while only one application installation is active.

Both actual candidate operator CLIs diagnose the original bad-request schedule
with exit 2, complete metadata, the matching source revision and unchanged owner
identity. Restoration replaces the observation process UUID and retains the
live/revoked session decisions. Encrypted model bytes and the original failed
run survive upgrade and restore. The enabled one-second schedule stays globally
paused and unarmed, with no automatic replay.

The independent provider ledger retains three calls: the original fixture HTTP
400, one explicit restored-candidate success and one explicit rollback success.
Rollback restores the earlier failed-run history before old code starts; the
post-backup success still exists in the provider ledger. The rollback retry is
another explicit action. Restoring disk data does not reverse external effects
or preserve changes made after the selected backup.

Four original Next process handles and their four source launchers exited;
observer/CLI stdio closed, instance registrations were removed and the listener
closed before each capture/publication. Windows Next termination is forced and
recorded as such. It does not establish graceful shutdown, bundled MCP descendant
teardown or isolated-container removal. The actual application profile runs on
Windows/Node 22.23.3 under one account with all four app records disabled and a
counted loopback OpenAI-format provider fixture.

Qualification retains seven focused archive/final-verdict cases, equipment
lint, canonical source typecheck/lint and both inspected non-container
application/five-MCP builds. Application inputs are unchanged by the equipment
and documentation, so build evidence is reused across the focused validation.
Measured builds took 342.190 seconds (candidate) and 154.833 seconds (baseline),
and source typecheck/lint took 60.870/97.605 seconds. Those durations are separate;
some development checks overlapped the candidate build. The final independent
live window was 25.929 seconds. Independent read-only review cleared the frozen
equipment/receipt after revision matching and late asynchronous refusal were
made explicit final-admission requirements. Source and emitted bytes matched
both build receipts again after the live run; the
[aggregate qualification](evidence/operator-upgrade-570-2026-10-14/qualification.json)
binds those checks and equipment hashes.

[Owned cleanup](evidence/operator-upgrade-570-2026-10-14/cleanup.json) ran through
standalone flujo-bash after all originals and provider handlers closed. Both
private profiles, archives, builds, generated types and duplicate dependency
installations are absent; source and frozen evidence are retained. The 27
verified targets contained 2.704 GiB of logical bytes. The measured free space
after cleanup was C: 115.207 GiB and E: 259.470 GiB.

#570 remains open. This is independent automated Windows source-consumer
acceptance, with prepared source builds and private fixture data. Published
package/installer/Linux/container release profiles, linked/concurrently written
backups, physical disk exhaustion, Security key-protection conversion, genuine
provider/accounts, worker recurrence/uncertainty and pending tool approvals are
not inferred from it. Existing operations/worker/migration/installation evidence
keeps its original scope. No full, remote, container or release workflow was
dispatched; those checks remain release preflight under the global pause.
