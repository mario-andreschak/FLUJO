# Hosted Windows native identity comparison

On one Windows Server 2025 host, the six fresh-file samples failed exact
descriptor/path identity with Node 22.13.1 and passed with Node 22.17.0.
This is a native temporary-file diagnostic; installed application startup and
release qualification remain separate gates.

| Runtime | libuv | Descriptor device | Path device | Six-sample result | Child exit |
| --- | --- | --- | --- | --- | --- |
| Node 22.13.1 | 1.49.2 | `742408122` | `0` | All six differ only in `dev` for closed-writer and read-only-reader comparisons | 1 |
| Node 22.17.0 | 1.51.0 | `742408122` | `742408122` | All six match | 0 |

Both probes reported successful cleanup. The aggregate diagnostic job concluded
**failure**, preserving the older-runtime mismatch. Capture-step summaries alone
are insufficient because the workflow continues after an unsuccessful child so
it can measure the second runtime; the retained child exit codes are authoritative
for the probe results.

## Source and hosted identities

- Reviewed probe: [PR #705](https://github.com/mario-andreschak/FLUJO/pull/705),
  `be939bc8f2e50e2f3e97357a4d2160b93fedd48b`.
- Hosted workflow/recorder: [PR #710](https://github.com/mario-andreschak/FLUJO/pull/710),
  exact checked-out source `8f09bfc177683ce34c95c09af22d83b17f423743`.
- [Actions run 37176590984, attempt 1](https://github.com/mario-andreschak/FLUJO/actions/runs/37176590984),
  `pull_request`, job `111360360300`.
- Runner label `windows-2025`, image OS `win25-vs2026`, image version
  `20260925.250.1`; OS caption `Microsoft Windows Server 2025 Datacenter`,
  version `10.0.26100`, build `26100`, 64-bit.
- Artifact `11293127563`; downloaded ZIP SHA-256
  `297bcf2cdc3658e3462e11c45fd030287593a44f77ee39f79d1dcb33a5e6e0c1`,
  independently matched against GitHub's reported digest.

The [source receipt](evidence/windows-runtime-identity-2026-10-04/source-receipt.json)
records both Node executable hashes, exact executed script hashes, the committed
source hashes, and Windows checkout CRLF conversion. Both runtime cases executed
the same probe and recorder bytes. It also inventories all eight extracted files
with byte lengths and SHA-256; their raw stdout/stderr hashes were independently
checked after download. The [original ZIP](evidence/windows-runtime-identity-2026-10-04/github-artifact.zip)
and all extracted files are retained with byte-preserving Git attributes.

## Interpretation and remaining acceptance

This comparison supports investigating a runtime change while retaining the
exact production identity guard. The two Node releases contain multiple changes;
the result does not isolate one upstream commit as the sole cause. The
[operations runbook](../../operations/windows-filesystem-identity.md) links the
upstream implementation evidence and the required installed-app qualification.

The workflow used fresh temporary files and built-in Node modules. It performed
no application build, consumer installation, workspace snapshot, provider/model
call or publication. The observation was operated and reviewed by AI; accountable
human review, the human security/release exercise and independent Engineering A-
acceptance remain unrecorded. The main 13-check release contract and configured
findings protection still apply to the integrated candidate.
