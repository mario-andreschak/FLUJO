# Artifact acceptance reports

The scorecard accepts a small retained producer report rather than committing a
complete npm archive, container image or installed filesystem. The **report checksum**
and **artifact digest** identify different byte sequences and must stay separate.
The 3.46.2 npm archive inspected by Docs is 10,286,028 bytes; copying its bytes into
the evidence directory is unnecessary and exceeds the validator's bounded witness
size. Report-only metadata, an archive digest and a declared source SHA remain
insufficient for installed acceptance.

The contract is `artifactAcceptanceReport` in
[scorecard.schema.json](scorecard.schema.json). It is a scorecard evidence contract,
not a runtime authority, dispatch permission, snapshot format or account-adoption
contract. Engineering owns the actual provenance/distribution validators, and
profile owners own installed security, browser/operator and operations matrices.

## Acceptance contract versioning

The same schema retains `acceptanceContract` as normative versioned policy data.
The scorecard validator uses it for cross-record checks: primary claim subjects,
minimum budget/kind/gate bindings, rubric evidence requirements, published human
targets and the evidence kinds allowed to carry human/live measurements. A general
JSON Schema validator checks shape; these cross-record requirements need the
scorecard validator too.

Review the schema, ledger and validator together. The contract stamp must match
the ledger's `schemaVersion`; changing a published minimum requires a separately
reviewed contract version and corresponding schema/validator changes. Extra criteria
may strengthen the minimums. Keeping these proposed targets in version 1 does not
record human agreement, a completed study or an accepted grade.

The original dimension/profile/platform sets, Persona limits and gate-kind rules
also remain enforced by validator code. Review those code tables alongside the
schema contract; the schema stamp alone does not prove they were independently
reviewed. Version 1 pins the still-proposed metric IDs and human sampling text.
Agreement that renames/splits/rejects a proposal or changes its sampling/basis text
requires a reviewed contract/schema/validator revision, not an ordinary ledger edit.

Original A- primary claims cannot become experimental exclusions or be replaced by
a weaker sibling claim. The separate Persona unattended claim may retain its
explicit experimental status, with its future budgets, kinds and gates intact.
Human metrics must be carried by human-study records, and live-stage metrics by
live-provider records; a decoy record of the right kind cannot qualify measurements
stored on a source or installed record. Duration measurements cannot exceed their
actual elapsed window. Every observation must be at or before the current validator
wall clock, and elapsed windows must have ended by their observation. A future-dated
human study or live run cannot qualify as completed evidence. The API's explicit
`now` option exists for deterministic synthetic admission tests; the CLI always
uses its current clock and exposes no override. These tests do not establish actual
elapsed observations. The validator checks correspondence, while actual human
identity, cohort selection and execution remain responsibilities of external review.

Runtime RSS/concurrency, recovery time and backup loss metrics require installed-artifact
carriers. Duplicate-effect metrics allow installed-artifact or live-provider carriers;
unauthorized-access and unresolved-finding metrics require security-review or
independent-assessment carriers. A source-check record may retain elapsed CI timing,
but declaring an elapsed window does not make it an installed-runtime measurement.
The five human targets also retain their published denominator, window and basis text;
rewording those sampling rules requires contract review.
The ten existing Persona soak contracts require offline-simulation carriers.
The separately controlled full-recall benchmark permits offline-simulation or
source-check carriers; its existing 20-search denominator remains mandatory.
A source-check recall measurement must retain an actual elapsed start/end window,
as specified by `sourceMetricElapsedBudgets`; an instant source observation cannot
qualify that measurement. Offline-simulation retains its separate virtual clock.
A simulated window on a static source observation cannot qualify a soak measurement.
New budgets may remain proposals without carrier rules, but passing checksummed
measurements fail closed until their reviewed `metricEvidenceKinds` entry exists.
Every source elapsed-policy ID must resolve to a ledger budget. Metric denominators
and count-valued measurements are integers. Any retained instant/simulated end must
be valid UTC, no later than observation and ordered after a known start; an unknown
historical start may remain null. A recorded physical end does not turn virtual days
into elapsed days. The original Persona units remain pinned with their limits and sample floors.
The recall contract imposes no new minimum wall duration. Actual controlled corpus,
full-candidate/ranking coverage and 20-search samples still need the performance
owner's runner evidence; a declared duration cannot establish those facts.

API validation results include `validationClock.source` (`wall-clock` or `override`)
and `validationClock.epochMilliseconds`; invalid clocks report a null value and fail.
CLI output prints its effective clock, including for a structurally invalid ledger.
File-read or JSON-parse failures occur before API validation and emit no clock line.
Retain these fields in new validation receipts. Older receipts remain historical;
clock provenance absent from an old result must not be reconstructed as reported data.

## Producer requirements

A report contains:

- `schemaVersion: 1`, overall `result`, exact `artifactId`, `sourceSha`,
  `payloadSha256` and `profileIds`;
- `producer` with tool name/version and its full source SHA;
- `checks`, each with stable ID, nullable profile/platform/install method,
  required policy, result and exact command.

For content acceptance, the producer must actually verify:

1. `content-digest`, profile ID null: hash the fetched/selected immutable artifact
   and compare it against the pinned expected identity. Container identity needs
   the immutable manifest digest and architecture selection, not a moving tag.
2. `source-provenance`, profile ID null: verify artifact/source correspondence
   with the distribution's real attestation/pin/build mechanism. Decode-only
   statements do not establish signature validity, issuer identity, inclusion,
   build correspondence or policy. Retain the mechanism's raw verification report.
3. `installed-runtime`, distinct required rows for the actual profile/platform/
   installation methods tested: install
   and exercise the exact identified artifact with that profile's accepted
   platform/provider/tool/browser/operator matrix. A source build or archive
   inspection cannot qualify this check.

A source-archive report requires the first two rows, with null platform and method,
and retains source-check scope;
it cannot qualify installed-artifact evidence. Missing, failed, skipped or
not-evaluated required rows are fatal for a passing report. Duplicate
`(check ID, profile ID, platform, install method)` rows are rejected.

The scorecard report can aggregate existing artifact-specific results. Its
commands and underlying producer evidence must remain available for review and
repetition. Do not turn a scanner summary, successful CI label, unsigned statement
or source fixture into a passed producer row.

## Scanner coverage

Retain a scanner result's exact source and analyzed commit/tree, base/ref, languages,
query suite, tool version and reporting filters with its raw report and job output.
Record whether coverage is full or restricted to a patch. A synthetic merge commit
can identify the same tree as a source head; compare the trees and retain both
identities rather than silently replacing the analyzed SHA.

[GitHub's CodeQL pull-request reporting](https://github.blog/changelog/2025-05-28-incremental-security-analysis-makes-codeql-up-to-20-faster-in-pull-requests/)
reports new alerts within changed lines. Its
[diff-informed analysis](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/scan-from-the-command-line/incremental-analysis#diff-informed-analysis)
uses those ranges to restrict reported results. Zero results from a narrow patch
therefore cannot establish zero findings across the repository or selected release.
Keep earlier findings and remediation/triage evidence visible; a successful upload
or a clean patch does not resolve them.

Security acceptance still needs evidence covering the full selected release and
declared installed threat matrix, with unresolved high/critical findings handled
under the agreed contract. Scanner output cannot qualify installation, human
review, workload windows or independent grade acceptance.

## Ledger wiring

1. Retain the producer's JSON report under the evidence directory. Preserve its
   bytes and compute its own SHA-256. External/raw dependencies can be linked
   separately; record their checksums, availability and any redaction.
2. Add an evidence entry with its actual revision, artifact, profiles, environment,
   commands, result and limits. `raw` includes the local report location/checksum.
   `artifactProof.location` points to that same local raw entry.
3. The report's artifact ID, source SHA and payload digest must match both the
   evidence and artifact ledger records. Its runtime rows must cover every profile
   named by the evidence. Runtime platform/method must match the declared matrix
   and artifact kind: a npm check cannot certify the Windows installer or a
   container. Report parsing occurs only after local checksum and
   repository/symlink containment verification.
4. Set `verified-content` only after a passing checksummed source/installed entry
   has the required producer proof. Otherwise retain `observed-metadata` or
   `not-observed`, even when a digest is known.
   A source-installed app uses a separate `source-build` artifact with its actual
   compiled build identity; the source repository itself does not establish an
   installed app result.
5. Keep the raw failure when verification fails. A failed installed observation
   may retain an unknown source binding; it cannot be promoted to passing until
   exact source/artifact correspondence is established.
6. Run the normal ledger validator, producer-specific validators and the full
   selected release acceptance. Source/installed checks still do not substitute
   for independent human review, observation windows or final grade judgment.

Each OS/install matrix row also retains evidence IDs. Marking it verified requires
passing installed reports covering **every declared method for that platform**.
One Windows/npm result cannot certify Windows/source/installer, Linux or macOS.
Version 1 rejects omitted platforms and installation methods; a scope change needs
an explicit reviewed contract version.

The producer report itself is a declaration. The scorecard checks its structure
and correspondence; it does not authenticate its author or independently repeat
cryptographic/runtime checks. Those facts need the real producer evidence and
external review. The unit tests use explicitly synthetic in-memory report records;
none is published as acceptance of an actual artifact.

## Current npm inspection

[The retained 3.46.2 inspection](evidence/npm-content-inspection-3.46.2.json) records
actual tarball SHA-256/SHA-512, registry integrity, both decoded subject comparisons,
the shipped package manifest and build ID. The provenance statement declares
`320347356891aa1c24e0f2f9ce12719317e58bde`; the shipped build is
`EKDYzpGxkbGh7LjwGF_Ru`.

It is **content inspection only**. No signature/issuer/inclusion policy was verified
and no package/runtime/MCP/browser journey was installed or executed. It has
`artifactProof: null`, remains `observed-metadata`, and cannot qualify a passing
installed result. The retained statement omits registry
`signedAccessSignatureUrl` fields while preserving decoded statements.
