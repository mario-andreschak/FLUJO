# Antigravity native maintenance — October 12, 2026

Scope: [#1094](https://github.com/mario-andreschak/FLUJO/issues/1094), native
runtime/discovery and existing approval, cancellation and usage boundaries.
Source base: `2395c079987006795dba636eabe38efffad3baf0`, including delivered
Codex #1117, persona recovery #1118 and MCP conformance #1119/#1120. Historical #529/1.2.13 acceptance is
retained as historical evidence, rather than reused for this runtime.

## Distribution and actual native contract

At 22:40:23 UTC, all eight official updater manifests advertised native CLI
`1.3.3-5524738307653632`. The package artifact map records those immutable
Google storage URLs and advertised SHA-512 values. Only Windows x64 was
downloaded, independently checksum-verified and executed in this maintenance
run. Manifest agreement is not qualification of the other seven artifacts.

The [official CLI changelog](https://antigravity.google/docs/changelog/#antigravity-cli)
still ended at 1.3.1/October 7 when checked. Release-note coverage for 1.3.3
is missing; no release date or changelog contents are inferred from artifact
timestamps. The
[Windows manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json)
identified a Windows binary whose independently calculated SHA-512 was:

```text
ec15855bd5de768232c0aee31d11eac636a9e7d8bc4ad3dbe3887a9797f7fd821cafabba61482cd5515674a05246be2b7f96ca3f17e38c6a3f7431a2a3aff81f
```

Actual `--version` returned 1.3.3. Native `models --output-format json` and
`models --json` exited 1 because their flags are unsupported. Native plain
`models` returned two-column TSV: six account-mode entries and eleven API-key
entries. FLUJO's wrapper now validates that table and projects the requested
JSON envelope with `entitlementVerified:false`. It rejects drift, duplicates,
controls and oversized output. No quota or model command enters an active
conversation stream. These listing probes established membership, without
paid inference or an entitlement assertion.

Package-owned resolution, receipt/checksum verification and disabled native
updates remain enforced. Diagnostics distinguish a present binary from a
verified runtime and report configured and actual versions. Discovery creates
a separate private invocation using the connection's auth mode; cache identity
includes version/auth mode and a process-private HMAC of credential material.
Keyring-only account catalogs are not cached across requests. A cleared key
selects account mode; an unresolved selected key cannot fall back to it.

The editor displays the returned label and exact slug, retains free-text custom
names and exposes no unverified effort controls. Account fallback suggestions
match the observed current table. Catalog membership does not establish quota,
subscription eligibility or API-key entitlement. Authenticated restricted
execution continues to exclude this provider.

Missing primary usage counters remain unknown; normalized totals are omitted
and valid reported counters are retained separately. Missing thinking detail
is omitted rather than manufactured as zero. Stop bounds pending approval and
local executor waits, passes an abort signal to cooperating executors, and
prevents late successful tool-result messages. Session reuse was not introduced.

## Focused source qualification

Local focused regressions and controlled source-built journeys are authorized
by the maintenance run. Full/online/packed/offline/multiplatform/container and
release acceptance remain pre-flight work; no CI workflow is dispatched.

The actual Windows 1.3.3 executable has passed the production private MCP bridge
round-trip with one nonce call/result/final answer, owned process cancellation,
disabled native updater with unchanged verified binary, and hostile
global/ancestor customization and command-like prompt isolation. Model traffic
in these native regression probes used a controlled loopback endpoint and a
synthetic API key, so they qualify the native boundary rather than live provider
entitlement or real FLUJO UI recall. Pure parser, discovery, auth selection,
diagnostic, cancellation/usage and editor regressions also pass.

Final application/test/package inputs are Git tree
`e4e043332f8c8da5ee6502fa21b4e96085a7035d` on the source base above. Only this
documentation receipt changed afterward. Typecheck, whole-source lint and final
changed-file lint passed. Eight focused model suites passed 109 tests; 15 editor,
13 selected Windows native contract cases and two pure catalog-parser cases
give 139 distinct focused cases, reusing valid unchanged inputs. The inspected
non-container application and five MCP builds passed in 656.925 seconds;
lease wait is separate from that measured build duration.

Thirteen built HTTP assertions passed from an isolated encrypted store:
account6/API-key11 catalogs, custom-slug save, saved encrypted-key discovery,
explicit cleared-key account selection, unresolved binding and foreign endpoint
refusal, present-but-unverified and missing-binary diagnostics, denial of an
earlier cached API-key catalog in both unavailable states, and restored runtime
discovery. Connection tests skipped model/tool attempts in unavailable states.
The catalog API preserves its existing error facade (HTTP 200 with an empty
list); the direct unresolved-key connection test returns its fixed HTTP 500
error. No upstream inference or real account credential was used by these
HTTP probes. The binary and receipt were restored and reverified afterward.

The built checks exposed the existing global-variable resolver returning an
unresolved binding as literal text. Antigravity now refuses that value in
catalog discovery, connection tests and direct runtime setup, before native
invocation or account fallback. A first 401.082-second build qualified earlier
inputs; the build and affected checks were repeated for this repair and current
MCP main. It is not used as final-build qualification.

## Remaining issue and release criteria

Keep #1094 open. Release pre-flight must still qualify source/packed/offline
distribution on every supported platform, including the deprecated
`unsandboxed` permission behavior. Real account/API-key entitlement,
refresh/revocation/unavailable models, UI recall/reload/usage/Stop and descendant
cleanup require current release acceptance. Windows loopback probes do not
replace those checks. Effort mapping requires verified per-model support.
Persistent stdin/session continuity, cumulative turn counters, crash/invalidation
rules and optional Python/managed API integration remain separate future work.
The broad #565 provenance audit is not repeated here.
