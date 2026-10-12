# MCP isolation v1 source primitive and evidence

This component advances #568 under epic #563. The application now calls this
primitive for explicitly approved isolated stdio profiles through the
[container transport integration](./mcp-isolation-integration-v1.md). Host launches
require separately approved trusted-host consent. #568 remains open for the
acceptance gaps recorded in that integration document.

## Enforcement and approval contract

`createIsolatedMcpLaunch` accepts a strict, versioned `docker-deny-egress` policy.
The caller must authenticate the owner, bind approval to that owner and workspace,
and compare the policy digest at launch and tool dispatch. A digest is neither
authentication nor a scanner verdict. Changed command, image, executable, daemon,
grant, or resource limit changes the digest and requires renewed approval.

V1 permits a preinstalled immutable image ID or repository digest and an absolute
Docker executable with an explicit local Linux daemon. It uses a private empty
Docker configuration rather than inheriting user contexts or credentials. It
rejects mutable tags, remote daemons, image-declared volumes, arbitrary flags,
duplicate grants, host-path traversal, and Docker/FLUJO control environment grants.
Only explicitly named environment values reach container creation; values do not
appear in argv, errors, or launch diagnostics. The attach process does not retain
them. The Docker daemon can inspect them and remains trusted.

The container receives a non-root user, no capabilities, no-new-privileges,
read-only root, no external network, bounded CPU/memory/processes, and bounded
scratch mounts. Filesystem grants are read-only and limited to explicitly named
paths under the selected workspace's `storage/mcp-grants/`. Symlinks/junctions in
the grant path are rejected. The caller must keep the trusted grant tree stable
between validation and daemon mount resolution; this component does not eliminate
host-side filesystem races or establish ownership of the selected workspace.

Container creation also requires Docker's `--init`. The trusted daemon supplies
the PID 1 process that forwards signals and reaps exited descendants, so the MCP
server does not have to implement a reaper. This is a fixed lifecycle rule; the
policy does not permit disabling it or injecting additional Docker flags. The
daemon-provided init belongs to the existing trusted daemon boundary, and its
process counts toward the configured PID limit. If creation fails, launch fails
closed. See Docker's [init documentation](https://docs.docker.com/reference/cli/docker/container/run/#specify-an-init-process).

Creation happens without executing the server. The returned attach command targets
the verified full container ID. Cleanup checks that ID and generation, removes
only that owned container, then observes absence. Docker client exit or successful
`rm` output alone does not prove cleanup. Failed observation/removal returns
`unknown` and keeps the control directory for reconciliation. A timed out create
can leave a stopped container; reconciliation attempts only the unique matching
generation and never reports that uncertain creation was fully cleaned up.

Unavailable Docker, image, grants, or validation fails closed. There is no image
pull, build, installation script, or host command fallback. Runtime children can
execute inside the container subject to its limits; v1 does not claim an exec
allowlist. Egress is denied entirely; destination allowlists are not implemented.

The daemon/VM, host administrator, approved executable/image, and kernel are
trusted. Linux containers on Docker Desktop were probed; native Windows containers,
rootless Docker, other daemons, and installed FLUJO artifacts remain unqualified.
Docker's documented controls underpin the policy:
[container resource/runtime options](https://docs.docker.com/engine/containers/run/)
and [rootless boundary](https://docs.docker.com/engine/security/rootless/).

## Reproducible source checks

The current managed-container reaping probe runs through the production launch
primitive and both installed SDKs, using an already installed Linux image:

```text
node __tests__/security/fixtures/isolated-mcp-reaping-probe.cjs <absolute-docker-executable> <explicit-local-daemon> <immutable-image-id> reaped
```

It holds an orphan until `/proc` shows adoption by PID 1, releases it, verifies
its disappearance while the server still answers tools, checks the actual
container restrictions, and observes removal of the owned container. Unobserved
cleanup retains its grant directory. The pre-fix launch produced a zombie in
both SDKs; the repaired launch reaped both descendants. The separate application
container tests passed genuine owner approval, discovery, dispatch, revocation
and cleanup. These source checks do not prove full official-image, provider or
worker shutdown acceptance; #568 and #700 remain open for their wider scopes.

Owned checkout: `C:\Users\Moe\.codex\worktrees\scorecard-security\FLUJO`, based on
main `3511ba49514fe8cf525f5a22c16c3806bf3886ba`. Node 22.13.1, Next 16.3.5,
TypeScript 6.0.3, Jest 30.4.2, Zod 4.4.3. Dependency files were not changed.

The focused tests use the checkout-local Next/Jest transform with an ignored
temporary configuration that corrects Windows managed-worktree test discovery.
The shared runner/config remains owned by Engineering. The temporary configuration
SHA-256 is `3b4be15b023d68c8585e1e59df293f02944b089198a8e2624286696c111e1e1a`.

```powershell
node scripts/run-local-jest.cjs --config .tmp/owner-jest.config.mjs --selectProjects node --runInBand __tests__/security/isolatedMcp.test.ts
node node_modules/typescript/bin/tsc --noEmit -p .tmp/isolation-tsconfig.json
node node_modules/eslint/bin/eslint.js src/backend/services/security/isolatedMcp.ts __tests__/security/isolatedMcp.test.ts __tests__/security/fixtures/isolated-mcp-probe.cjs
```

The scoped TypeScript configuration extends the repository configuration, includes
the new module and test, disables incremental output, and explicitly loads the
Node/Jest type packages. These checks do not replace a repository typecheck/build.
Root owns the shared heavy-check slot; full checks are pending integration.

Failures retained: the first unit run had 25 passes and one failure because an
empty command triggered an unsafe schema refinement; the guard was corrected and
the 26-case rerun passed. The first scoped TypeScript run rejected optional Jest
mock arguments and receipt assignment narrowing; those errors were repaired and
the scoped check passed. Two additional cases then covered a non-Linux daemon and
timed out creation reconciliation; the final focused run passed all 28 cases.

## Local Linux image conformance probe

On 2026-10-03 this command ran against the already installed image, without a pull,
using only synthetic fixtures and a 128 MiB / 0.5 CPU / 32-process limit:

```powershell
node __tests__/security/fixtures/isolated-mcp-probe.cjs 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' 'npipe:////./pipe/dockerDesktopLinuxEngine' 'sha256:fc8cd9deea7389d01d9a70cc83a5d09465c2050f2ae322d67300a9794433edad'
```

Exit code: 0. The image ID fixes local image contents; registry provenance was not
verified. No user private fixture, provider, credential, or existing container was
accessed or changed. Only the probe's own container and validated temporary paths
were removed.

| Observation | Result |
| --- | --- |
| Approved file read and explicitly granted environment | Allowed |
| Granted file write, root write, ungranted sibling read | Denied |
| Synthetic host secret inheritance | Absent |
| Non-root UID, effective capabilities, no-new-privileges | 65534, zero, enabled |
| Connection to documentation address 192.0.2.1 | Kernel network-unreachable error |
| `memory.max`, `pids.max`, `cpu.max` | 134217728, 32, 50000/100000 |
| Bounded `/tmp` write | Allowed |
| Cleanup | Exact owned container removed and absence observed |

The cgroup readings verify configured limits, not an OOM/fork/load soak. The probe
transpiles the source module with the local TypeScript compiler; it is not a packed
or installed FLUJO test, an independent audit, or a complete MCP journey.

## Remaining acceptance work

The transport integration adds ordinary and beta client launch, reconnect keys,
final tool dispatch, approval revocation and generation-bound cleanup receipts;
its current checks and live-container limitation are recorded separately.
Owner/workspace grant persistence,
browser approval/review flows, install-time isolation, destination-specific egress,
supported-artifact negatives, scanner/review signals, human review, and independent
reassessment remain required. AI review under #101/#527 is evidence only and never
substitutes for this OS boundary or grants additional authority.
