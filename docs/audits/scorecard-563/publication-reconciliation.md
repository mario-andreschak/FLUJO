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

## October 5 source outcomes

The [checksummed v25 observation](evidence/source-outcomes-2026-10-05-v25.json)
records the public progress cut updated on October 5, 2026 at 13:52:46 UTC. It is
a dated reconciliation of retained producer/reviewer reports and the earlier
independent Docs readback; those workloads were not repeated for this ledger edit.
The report identifies its derived scope, original review receipt checksums and
private raw-evidence access limits. Later outcomes require separate observations.

At this cut, published integration #611 still identified `aa924df5` / tree
`d09c5ccd`. Mapped `db4bb26f` / tree `e26b744d` had normal publication authorization.
Its tree equals the qualified marker component merge `a891d7f3`; its integration
check identities and outcomes remain separately required. Neither identity is a
selected distributed release or an installed-profile acceptance record.

| Observation | Recorded result and boundary |
| --- | --- |
| AA integration ordinary verification | 11 required checks passed and two failed. The ordinary archive retains 8,674 passing assertions, one append-scaling timeout and 11 skips. The unchanged test limit was 1,800,000 ms; its cause remains unresolved. This is an overall benchmark timeout, not a new append-p95 measurement. Builds, types/lint and eight supported profiles passing do not erase the ordinary/final verification failure. |
| AA native findings protection | Failed with 49 new findings (28 high, 21 medium) and 80 open alerts (45 high, 35 medium). Analysis completion, component scanning and a lower count do not establish individual disposition or backlog clearance. Installed-profile applicability is not asserted. |
| Marker component #780 | Head `c69fba0f`, actual merge `a891d7f3`: all 13 required checks passed. Fresh archives retain 16 marker and 20 unchanged transfer assertions with zero selected skips; ordinary 8,691 passed, zero failed and the original 11 skips; isolated 105 assertions in nine suites. Eight supported source/runtime profiles and two historical build-only rows remain distinct. Earlier type/fixture failures are preserved. These component results are not relabeled as a new integration run. |
| Recording #784 | Predecessor `7af0ec00` passed 14 new cases and failed three warning matchers; 38 unchanged browser assertions passed. Later byte-bound and close assertions in the three interrupted cases did not execute. Successor `ad0b1a9b` changes one matcher, preserves production and all 17 case bodies, and needs fresh qualification. |
| Worker payload export #783 | Exporter source `8800ecfe` passed seven fixtures, the separate immutable `8fe5985e` application build and production dependency install, then failed export when its private-data filter rejected compiled API paths. Diagnostics were uploaded; no compiled payload was produced. Exporter and application source identities stay separate. |
| Worker export successor #785 | `b5abe6eb` retains all seven cases and adds two cases covering six allowed compiled paths and 22 rejected lookalikes. Four exact compiled filenames and one tightly bounded static chunk filename are admitted while private/live-data denials remain. Nine fresh hosted fixtures precede a separately selected build/export event. Prior fixture/build passes are not transferred. |
| Earlier 8fe Docs evidence | Exact source `8fe5985e` / tree `4f318966`: 99 cases passed with zero failure/skip/cancellation/todo; direct exits `0/0/2/0`; 72 source-selected documents, 403 file targets and one directory target verified. Closure remains incomplete with 20 blockers. This new source edit requires fresh validation and does not inherit those results. |

The native bootstrap's compiler and linker each completed with exit 0 and pinned
outputs, while separate MSVC child-process closeouts remained material. The first
child was independently absent, but its failed closeout, missing inner error and
unproven termination cause remain recorded. The linker child had a distinct narrow
closeout authorization at this cut. Both disposable controls were unentered pending
independent release and a separate fixed window; the lifecycle successor still
needed 17 pure fixtures and runtime acceptance. Compile/link success does not
qualify helper survival, worker behavior or a signed installed application.

All prior ledger evidence and failures remain unchanged. These new source records
add references without changing claim/gate status, rubric agreement, numeric budgets,
profile acceptance or assessment. The nine accountable human owners, participation,
contributor activity, sustained usage and independent reassessment still need actual
evidence. Source consistency and publication authorization grant no grade or human
acceptance and do not close #563.

## B078 terminal evidence after the fixed v33 checkpoint

The [separate terminal observation](evidence/source-outcomes-2026-10-05-b078-terminal.json)
binds source `b078484c` / tree `cb1eb750` to actual merge `445d59ae` and
original run 37333223553, attempt 1. Queue retained nine original server archives,
20 expanded report/profile members and the complete original run archive's 110
logs before this Docs successor was prepared. Docs rehashed 266 explicit original
file pins and joined the 19 unchanged source inputs without repeating workloads.
The committed observation is derived; access to the private originals remains
necessary for independent raw-evidence review.

All 13 ordinary verification jobs passed. Main retained 8,708 passing tests in
910 passing suites, zero failures, and the existing 11 skips in five suites;
isolated retained 105 passing tests in nine suites with zero skips or failures.
The fresh combined reports retain all 17 new recording and 38 unchanged browser
assertions across nine selected suites, plus 16 marker and 20 unchanged transfer
assertions. Eight supported source/runtime matrix records passed their Ubuntu
and Windows installed/packed MCP and proxy controls; the two Node 22.13.1 records
remain historical build-only rows. Those control scopes do not qualify a selected
distributed FLUJO release or the ledger's installed profiles.

The unchanged 20,000-append assertion passed in 1,210,662 ms. Its 19 original input
objects remain unchanged. AA's 1,800,000 ms timeout and DB4's 1,711,284 ms pass stay
on their original sources; no timeout cause, append-p95 result or performance
grade follows from comparing those durations. The separate B078 native finding
check remains failed: 49 new (28 high, 21 medium), 78 open (43 high, 35 medium),
zero critical. Its 262 related URI/index disagreements and their unproven cause
remain visible. Snapshot absence of browser finding #167 grants no disposition.

Recording AD0's own 55 selected passes and worker B5's nine original fixture
passes are separate later observations. The fixture record does not independently
requalify the worker production inner archive or native/runtime behavior. The
fixed v33 context retains the separate payload metadata review, finite native
controls, expired 100/250 diagnostic grants, launcher refusals and unrun runtime
acceptance. Preferences draft #788 requires its own distinct qualification.

The original v25 observations, claim/gate statuses, rubric, numeric budgets,
profiles, human owners and assessment remain unchanged. This new Docs leaf needs
fresh focused source checks. The earlier addbc result is not transferred; neither
source validation nor CI success supplies installed, human or A-minus acceptance.

## October 6 current-candidate API observation

The [current candidate record](evidence/current-candidate-e622ccfe-2026-10-06.json)
retains seven exact API snapshots for PR #803, its immutable source/tree, main,
original verify attempt 1 and jobs, current check runs and CodeQL analyses. At
the observation, main remained `0be972ac`; candidate source was `e622ccfe` /
tree `dd5f5c47`. The original run failed after five jobs succeeded and seven
were cancelled; the aggregate verification gate failed separately. The skipped
diagnostic is excluded. Cancellations from other workflows are not combined into
this count. Both CodeQL jobs were cancelled and no exact-source analysis was
returned. This establishes missing analysis evidence, without scanner clearance.

The minimal composition applies the accepted #791 commit `56912d47` onto the
exact candidate, retaining all four accepted file bytes, then adds this observation.
No product, workflow or runtime source changes are needed for that Docs composition.
Fresh validation belongs to the resulting Docs source. The fixed v25/v33 reports
and B078/445/cb1 qualification stay immutable; no prior result qualifies the new
composition. Release/profile acceptance, all named human responsibilities, rubric
agreement and the independent nine-row assessment remain pending.

A [separate attempt-2 snapshot](evidence/current-candidate-e622ccfe-attempt2-2026-10-06.json)
retains the verify and installer recovery metadata without changing attempt 1.
Any original successful jobs carried by GitHub must retain their original job
identity; this reuse is not new execution. Recovery remains unqualified until its
complete exact-source reports and original evidence are reviewed. This Docs
observation initiated no retry or target workload.
