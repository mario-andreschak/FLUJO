# Proposed maintained Node runtime contract

This is a concrete proposal for root/Production review, not an implemented
support claim. The hosted native-file comparison in
[PR #712](https://github.com/mario-andreschak/FLUJO/pull/712) preserves the Node
22.13.1 failure and Node 22.17.0 success. The remedy must use a current patched
official runtime and independently qualify installed startup with the exact
filesystem identity guards.

## Proposed version eligibility

The [dated official-index observation and source inventory](../audits/scorecard-563/evidence/node-runtime-support-proposal-2026-10-04.json)
records the repository's **six** engine declarations: the app and five MCP/shared
packages. All six would declare this same range:

```text
^22.17.0 || ^24.2.0
```

| LTS family | Compatibility floor | Current patched target observed October 4, 2026 (UTC) | Proposed use |
| --- | --- | --- | --- |
| 22, Jod | 22.17.0 / libuv 1.51.0 | 22.23.3 / libuv 1.51.0 | Default production/installer/CI qualification baseline |
| 24, Krypton | 24.2.0 / libuv 1.51.0 | 24.21.0 / libuv 1.52.1 | Existing npm publication toolchain, upgraded from its 24.17.0 pin; eligible consumer runtime |

The exact release entries were read from the
[official Node distribution index](https://nodejs.org/dist/index.json).
This explicitly changes the app's current `>=22.0.0` and all five MCP/shared
packages' `>=20` claims. Node 22 below 22.17.0, Node 24 below 24.2.0, end-of-life
majors such as 20/23/25, prereleases, malformed versions and unknown future majors
would be refused. Node 26 is vendor-maintained Current, not an end-of-life release;
it is explicitly outside this proposed two-LTS-family contract. Compatibility
floors identify eligible runtime mechanics, not a guarantee of current security
patches. Default installs/images and production qualification use the current
patched targets; an older eligible edge is a separate regression fixture.
Windows, Linux/macOS and the three operating profiles keep their existing scope;
version eligibility does not establish installed/profile acceptance.

## Required failure behavior

One built-in, side-effect-free runtime policy would check the complete stable
major/minor/patch tuple and actual `process.versions.uv` against the closed
22/24 compatibility floors and libuv 1.51.0 minimum. It must be evaluated before application or
MCP initialization can create data roots, load user configuration, open databases,
connect stdio/transports, migrate workspaces or call a provider. Direct supported
Next/server startup paths require the same Node-only preflight; package engines
are advisory and cannot replace it.

Refusal exits nonzero with the actual Node/libuv versions and the supported
ranges, without configuration values or private paths. It starts no application
child and leaves user data unchanged. Node 22.17.0 and 24.2.0 are eligible minimum
edges; that does not make them current patched deployment choices. Eligible Node
metadata with an older/unparseable libuv also refuses.
Existing running processes are not terminated by this preflight.

Installers may install/upgrade a prerequisite through their existing authorized
OS package-manager path, then must probe the actual Node on PATH again before
clone/build/start. Windows and Unix comparisons must include the **patch** number;
the current Windows helper parses patch but compares only major/minor. A failed,
malformed or stale-PATH post-install probe stops installation with retained
diagnostics. No installer reports success based on an engine warning.

## Surfaces that must agree in the implementation

| Surface | Required concrete change and evidence |
| --- | --- |
| App and five MCP/shared packages | Same maintained-line range; synchronize root/workspace lock metadata; independently check every emitted manifest |
| npm CLI, source launcher, direct server and MCP bins | Shared early runtime preflight, included in packed payloads; unsupported-process tests show no data/config/provider/child effects |
| Windows/Unix bootstrapper and compiled installer contract | Full tuple/line validation before application work and after prerequisite installation; upgrade/refusal behavior covered by existing Pester/Unix fixtures |
| Required production/verification jobs | Pin the 22.23.3 baseline on Ubuntu and Windows, retain default heap and all 13 required names; keep historical 22.13.1 diagnostics red |
| npm publication | Pin its existing 24-line toolchain to 24.21.0, retaining exact-source/candidate/provenance gates |
| Image/worker/MCP runtime images | Select the reviewed current patched line; record actual image/runtime identity and qualify immutable tested payloads |
| README, contributor/operations/release/security guidance | Publish the explicit compatibility transition, preflight error and upgrade route; distinguish eligibility from supported installed profiles |

## Acceptance before integration/release

Retain the existing Node 22.17.0 minimum-edge diagnostic without rerunning its
published packet. Qualify the 24.2.0 edge and run the reviewed native probe with
**22.23.3 on Windows Server 2025** when the new candidate enters qualification, and
retain source, executable, image and metadata identities. The 22.17.0 result is
historical diagnosis, not this current-runtime qualification. Qualify any other
runtime line/profile before treating it as accepted consumer evidence.

Then run the ordinary default-heap production build, release payload checks and
installed app/MCP smoke on the proposed exact source and runtime. Preserve old
startup failures and all exact descriptor/path checks, including device/inode,
link and timestamp rules. There is no device truncation, masking, fallback
admission, skipped production check or publisher bypass in this proposal.

Focused refusal cases must cover each line immediately below/at its patch floor,
EOL/unknown majors, prerelease/malformed Node or libuv output, missing packaged
preflight, partial engine/lock synchronization and stale installer PATH. Main
publication still requires independent review, configured findings protection,
and the successful current-attempt 13-check verification for the merged exact
main SHA. Human release/response responsibility and independent grading remain
unassigned and unaccepted.
