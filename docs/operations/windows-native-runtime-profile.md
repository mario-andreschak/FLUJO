# Measured Windows native filesystem runtime profile

Qualification binds a source/artifact, operating system and Node/libuv tuple.
The results below cover temporary files created by the diagnostic probe, not
the installed FLUJO application, worker recovery or a human operator drill.

| Operating system/image | Node / libuv | Exact native file identity | Installed FLUJO on that tuple |
| --- | --- | --- | --- |
| Local Windows 10 Pro 10.0.19045 | 22.13.1 / 1.49.2 | Six samples pass | Separate queue source `80733be5` passed its actual installed consumer; this does not qualify later source |
| Windows Server 2025 Datacenter 10.0.26100, image `20260925.250.1` | 22.13.1 / 1.49.2 | Six samples fail on `dev`; descriptor `742408122`, pathname `0` | #692/#697 installed startup refuses with `closed-owner:dev` |
| Same hosted machine and image as the preceding row | 22.17.0 / 1.51.0 | Six samples pass all checked fields; descriptor/path `dev` both `742408122` | Historical native probe only; unsupported by the current runtime contract |

Engineering PR #710 source `8f09bfc177683ce34c95c09af22d83b17f423743` ran the
original #705 probe (`be939bc8`) in both Node processes on the same machine.
The pull-request run is
[37176590984](https://github.com/mario-andreschak/FLUJO/actions/runs/37176590984),
job `111360360300`; artifact `11293127563` retains both runtimes' raw metadata
and exit codes. Its result remains FAIL because the older runtime's refusal
is retained. Both processes completed owned cleanup. This run did not execute
the subsequent #708 descriptor-binding correction.

## Runtime explanation and its limits

Two primary upstream corrections are relevant:

- libuv [corrected the Windows metadata structure's member order](https://github.com/libuv/libuv/commit/abe59d6319973cbff0686f41869cf8ae50bab1d2).
  Microsoft's [structure declaration](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-file_stat_basic_information)
  places `VolumeSerialNumber` before `FileId128`. Node 22.13.1's fallback
  declaration has the opposite order; Node 22.17.0 has the corrected order.
- libuv also [corrected inconsistent volume serial number representations](https://github.com/libuv/libuv/commit/82cdfb75ff9bbd0dc65820ca418b7c5d412ff4d7)
  between descriptor and pathname statistics.

The native experiment reproduces the device discrepancy under the affected
runtime and observes its absence under the proposed runtime. The structure
correction supports an explanation for a pathname device value of zero;
attribution to an individual libuv commit remains an inference. This run
changes Node/libuv together and does not prove installed startup.

## Current public runtime contract

The app, four public MCP packages and internal shared workspace require
`^22.23.4 || ^24.22.1`, matching their six engine declarations and
[`bin/node-runtime.mjs`](../../bin/node-runtime.mjs). Use Node 22.23.4 or later
within 22.x, or Node 24.22.1 or later within 24.x. Earlier Node 22/24 releases,
Node 23 and every other major fail the current guard.

The historical filesystem measurements above retain their original Node/libuv
tuples. Those probe versions and the earlier proposed `^22.19.0 || ^24.2.0`
range do not meet today's security runtime floor and are not current installation
advice. Supporting another major requires an updated runtime policy and fresh
qualification.

The app binary and four MCP entry points import a bounded preflight before
dependency initialization. Each independent MCP tarball embeds byte-identical
copies of that policy and preflight; release validation checks their presence,
contents and entry order. Direct `npm start`/`npm run dev` launchers check the
same policy before environment loading and instance preparation. No command
line option or environment variable bypasses the check.

Application launchers report the active Node version and executable without an
exception stack. In an interactive terminal they offer an optional Node update;
`--update-node` provides explicit consent for a non-interactive app launch. The
bootstrap downloads the latest LTS release on the existing supported major
(22 or 24; other majors migrate to 24), verifies the official archive SHA-256,
installs it in the user's `~/.flujo/node-runtimes` directory, verifies the actual
executable's version, and restarts the original command with that runtime and
its tools first on PATH. A local receipt binds subsequent reuse to the installed
executable's SHA-256. Application dependencies remain behind a synchronous
preflight boundary throughout consent and installation. Declined or failed
updates exit with manual installation, terminal reopening and PATH recovery
steps. MCP entry points remain non-interactive and emit guidance only on stderr;
their host must activate or explicitly select a supported executable.

The Windows installer rejects an unsupported existing Node runtime before
execution-policy changes or prerequisite installation. Install and activate a
current patched 22.x or 24.x release, then re-run. It deliberately requires the
operator to choose that migration instead of silently switching an existing
runtime. Missing Node uses the `OpenJS.NodeJS.LTS` winget package. The Unix
installer also refuses an unsupported existing runtime before network setup,
Homebrew bootstrap or any prerequisite installation; when Node is absent,
it uses its package-manager path (including Arch's `nodejs-lts-krypton` and
Homebrew's `node@24`, explicitly linked onto Homebrew's PATH). It refuses to
proceed if the resulting runtime is outside the same closed range. Both recheck the
active runtime before building the app. Package managers may later select a
different major; that result remains a refusal until the policy is reviewed.

Current release qualification must cover both supported minimum edges and
selected current patched LTS runtimes on Ubuntu/Windows, including the actual
packed-process checks. Review runtime source and its CI coverage together.
Retain the original Windows 22.13.1 ordinary default-heap build and installed
startup refusals as historical evidence only; those records do not qualify a
current runtime. No identity guard, test quarantine, scan finding or installed
acceptance requirement is relaxed.

## Remaining release qualification

Retain the original Node 22.13.1 default-heap build record that exposed the
earlier memory failure and the installed-startup refusal evidence. Qualify the
exact integrated candidate on hosted Windows Server 2025 with supported Node
22.23.4 or later within 22.x:

1. Record the Git head/tree, OS/image, actual Node/libuv, package identities and
   corrected probe source. Preserve any new scan findings for independent
   review; #708 alert #270 remains open at this document's publication.
2. Execute the ordinary `npm run build` with default Node heap, then
   `npm run typecheck:mcp` and `npm run validate:mcp-release`.
3. Run `npm run smoke:mcp-artifacts` with the actual packed app and all four
   public MCP packages. Require real installed startup, workspace initialization
   and the app's Streamable HTTP proxy to pass; retain exact tarball hashes,
   dependency resolution and process outcomes.
4. Repeat with Node 24.22.1 or later within 24.x and qualify the selected
   current patched LTS deployment/image runtimes. Verify installer migration/refusal behavior
   on actual machines. The current engine range is a compatibility policy;
   measured native metadata alone does not qualify either installed profile.

Keep exact bigint identity, regular-file, link, owner/mode, parent, content and
transition checks intact. Never accept a zero device value, mask/truncate an
identity, or coerce it to Number to make the old runtime pass. A native pass
does not complete real cron/crash acceptance, descendant cleanup, OS/user
isolation, sharing, non-author human drills or the independently accepted A-.

## Retained local receipt

`production-hosted-native-runtime-ab-710-37176590984.json`, SHA-256
`851cef0ef6326910b947be6d3339434d3328c11863b5bc56d7233b703924fcac`,
in the production topic's shared artifact directory, pins all eight downloaded
artifact members and the observed runtime profiles. The GitHub artifact API's
archive digest is recorded; it was not independently recomputed from a ZIP.
