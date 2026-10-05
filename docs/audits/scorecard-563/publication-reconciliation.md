# Publication reconciliation for scorecard #563

The [retained report](evidence/publication-reconciliation-2026-10-03.json)
captures twelve named documentation files at planning main
`3511ba49514fe8cf525f5a22c16c3806bf3886ba`, on October 3, 2026 at 22:41 UTC.
Each present file has its Git blob identity, byte length, SHA-256 and selected
line excerpts. The absent `SECURITY.md` has a dated Git-tree witness. These are
source-document observations, not confirmations of the documented behavior.
They do not describe the contents of npm 3.46.2 or an integrated scorecard release.

Eleven concrete publication claims now reference this evidence in
[scorecard.json](scorecard.json). They remain pending. The baseline wording,
existing qualifications and required candidate changes are retained together;
finding a qualification somewhere in a long guide does not substantiate a
broader feature bullet.

## Findings and delivery owners

| Publication claim | Captured scope and required reconciliation | Owner / acceptance |
| --- | --- | --- |
| Local/public ingress | README offers public deployment, while its network section, API guide and architecture distinguish exposure controls from authentication. Put the authenticating-proxy and single-owner limits beside the short feature claim. Proposed owner/session/shared enforcement is not shipped by an unmerged PR. | Security; local ingress, shared-profile and installed-release gates |
| Storage encryption | The README's short encryption bullet omits the published default-password limit. The encryption guide separates v2 writes, legacy CBC, explicit plaintext repair, server unlock and backup-dependent downgrade. Bring those limits into the product summary and release migration notes. | Security; migration and installed-release gates |
| Secret redaction | “Never sent to the browser” is an absolute assertion across surfaces. Configuration masking does not establish every error/log/export/transfer boundary. Replace it with a scoped statement backed by the candidate redaction matrix. This report does not assert a browser leak. | Security; redaction review and installed-release gates |
| Workspace/user isolation | Architecture says single-user; API selectors identify logical partitions; workspace dependencies do not create a process boundary. Preserve those limits until individual ownership, team sharing, revocation and edit conflicts are accepted. | Production; #573/#574/#575 and security gates |
| MCP confinement | The MCP guide says local servers use host-user permissions and installation scripts can execute code. Roots, approvals, package inspection and the Apps origin must stay distinct from enforced process/filesystem/network capabilities. | Security; #568 and installed adversarial matrix |
| Worker transfer/recovery | The worker guide discloses credential-bearing archives, dedicated bearer ingress, copied-schedule suppression and manual recovery of interrupted effects. Retain these limits when documenting local-schedule opt-in and generation-bound shutdown receipts. | Production; #553/#547, operations and consumer contracts |
| Distribution/OS support | README advertises installer/npm/source/container methods. Release guides distinguish pinned inputs, byte checks and clean-machine acceptance. A source version/build or API checksum cannot make every OS/method row verified. | Engineering; actual release artifacts and full install matrix |
| CI and dependency health | Status/changelog describe scoped CI and historical remediation. Preserve opt-in/skipped tests and the fresh failing October audit; tie replacement results to the integrated release, not another PR or September's clean audit. | Engineering and Maturity; release, dependency and current-soak gates |
| Persona autonomy | README/status/changelog retain experimental scope and historical failure; worker mode explicitly suppresses dispatch. Later old-source reports, current offline checks, elapsed live time and useful human outcomes remain separate. | Maturity and Feature surface; current soak, manual, live and reviewer gates |
| HTTP/MCP compatibility | The API guide distinguishes curated external contracts from internal administration, experimental APIs and generated route coverage. Keep authentication, workspace and retry limits in examples; update versioned consumer agreements with behavior changes. | Feature surface and Production; installed journeys and cross-stream contracts |
| Release threat model | No `SECURITY.md` exists in the captured main tree. Scattered guides and a security proposal do not constitute an independently reviewed release threat model. Add the selected candidate's policy/threat model to the next inventory. | Security; scoped review, reporting/migration policy and independent reassessment |

The report is a bounded manual review of the listed files. It does not claim
exhaustive discovery of every product statement or an independent security
assessment. Topic owners retain their documentation and behavior ownership.

## Candidate wording for the short security summary

These proposed replacements are review inputs. Publish factual promises only
after checking the selected implementation and the corresponding release evidence.

- **Local-first by default:** one trusted operator on localhost. Deliberately
  exposed deployments need authenticating network controls; workspace selection
  alone does not provide individual user isolation.
- **Stored credentials:** use a private encryption password for protection at
  rest. The public default password provides obfuscation. Upgrading does not
  repair every historical plaintext or rewrite every legacy ciphertext; follow
  the migration guide and retain a complete backup before upgrading.
- **Credential handling:** ordinary configuration screens mask stored credentials.
  Backups, worker snapshots, logs and diagnostic material require separate
  handling and review. Avoid a promise covering every browser response unless
  the retained release redaction matrix establishes that scope.

These source-era proposals need revision if the integrated candidate changes
owner authentication, encryption, API behavior or the supported operating envelope.
The current README's detailed privacy, host-permission, network and worker limits
remain relevant evidence for that review.

## Repeat for the actual release

1. Select the integrated release SHA and its actual npm/container/installer
   identities. Capture a new immutable inventory from that Git tree; retain
   this baseline report. Include the candidate security, architecture, API,
   recovery, install and resource guides created by the delivery topics.
2. Bind each publication claim to the candidate source/artifact/profile and
   the required passing evidence. Verify each advertised OS/install method,
   migration/rollback and external provider/tool prerequisites. Keep failed,
   skipped and human/manual outcomes visible.
3. Resolve disagreements with each topic owner and the independent reviewer.
   Align README, project status, release notes, threat model and API/operations
   examples. An unmerged proposal or source fixture cannot substantiate a
   shipped feature, user isolation, live autonomy or human usability claim.
4. Run ordinary ledger validation and `--closure`. Ordinary success verifies
   declarations/checksums; closure stays open until acceptance is complete.
   The reviewer must separately assess authenticity, complete claim coverage,
   the operating envelope and all nine original scorecard rows.

To reproduce a document observation, obtain the named blob with
`git show <sourceSha>:<path>` as bytes, compare its SHA-256 and line excerpts
with the report, and use `git ls-tree <sourceSha> -- SECURITY.md` for the absence
witness. Hash Git blob bytes rather than a checkout or a shell-reencoded text
stream: Windows line-ending conversion can otherwise change the payload.

The dependency-free [publication checker](../../../scripts/check-scorecard-publication.mjs)
reads an exact committed tree, inventories the twelve named guides and every
Markdown file added, changed or removed under `docs` since planning main, and
checks parsed relative file targets against that same tree. For the selected
candidate, run:

```sh
node scripts/check-scorecard-publication.mjs --source <exact-40-character-release-source-SHA>
node --test scripts/check-scorecard-publication.test.mjs
```

An explicit `--baseline <exact-40-character-SHA>` can select a different review
baseline. Exit 0 means the scoped file-target check passed; exit 2 retains a
report with missing or invalid targets or mandatory guides; exit 1 indicates
invalid input or an execution error. Removed nonmandatory guides remain in the
report for manual claim reconciliation. A surviving link to a removed guide
still fails. Preserve stdout as bytes when retaining the report as evidence.

The checker records each present guide's Git blob, byte length and SHA-256,
including original line endings. It does not parse HTML or arbitrary Markdown
extensions, check anchor existence, external or root-relative routes, render
pages, or establish documented behavior or exhaustive claim coverage. Its
report cannot award a grade, replace independent review, or qualify an installed
artifact. Keep the original manual inventory and perform the release
reconciliation above.

Development/push/deployment authorization and empirical acceptance are separate
records. The coordinator owns the integration and deployment candidate. No
numeric paid-run envelope or concrete model/account scope is declared in this
ledger; its proposed null paid-run limit records that missing measurement contract,
without denying the user's development/deployment authorization.
