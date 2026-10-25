# Local MCP execution profiles and support

Use a protected execution profile when an MCP server must have a reviewed runtime
grant. Browser iframe isolation, a trust checkbox, a source review score and a
private runtime HOME do not confine a local process. The unconfigured native
localhost compatibility mode still has the local account's privileges; it is
outside the protected isolation contract. Remote MCP operators control their own
hosts and receive the data sent to their endpoints; local container controls do
not constrain them.

## Profiles

| Capability | `docker-deny-egress` | `trusted-host` |
| --- | --- | --- |
| Source identity | Preinstalled immutable image ID or repository digest, resolved to the local image ID before creation | Exact executable and bounded materialized source/dependency digests |
| Filesystem | Read-only named grants beneath the selected workspace's `storage/mcp-grants/`; nested mounts excluded; read-only root | Owner account access; approved roots describe protocol access and provide no OS confinement |
| Environment | Only named grants enter the container; no inherited host environment or application credentials | Only approved environment names and separately authorized runtime credentials |
| Network | No external network; destination allowlists are unsupported | Owner account network privileges |
| Children | Container PID namespace and approved PID limit; children may execute inside that boundary | Owner account process privileges |
| Resources | Approved memory/swap, CPU and PID limits, bounded `/tmp` and shared memory | Host account resources; no container limit claim |
| Consent | Private owner/workspace/server approval binds the complete policy digest | Separate private owner/workspace/server approval binds source, command, environment and capabilities |
| Installation | No pull, build, package download or lifecycle script | Runtime approval does not authorize install/build scripts |

Both protected profiles check current authority before launch and final tool
dispatch. A changed source revision or requested capability requires renewed
approval. Imported profiles carry no authority. Missing, invalid, expired or
revoked grants refuse execution. A malformed isolated profile, unavailable
daemon/image or mismatched configuration never falls back to host execution.
Owner and approval files use stable private-file reads, including native Windows
SID/DACL checks and POSIX ownership/permission checks.

Container environment grants travel through an exclusive private `--env-file`.
The empty file's privacy is checked before secret bytes are written, including
native ACL validation on Windows. Every Docker subprocess receives only the
fixed host essentials, so container names such as `LD_PRELOAD`, `PATH` or
`GODEBUG` cannot configure the host launcher. The file is removed immediately
after creation succeeds or fails, independently of container reconciliation.
Values containing NUL, CR or LF are refused; Docker's environment-file format is
line based. Secrets are excluded from argv, inspection output and diagnostics.

Before creating a container, FLUJO requires a Linux daemon that advertises memory,
swap, CPU quota/period and PID limit support. Rootless daemons are unsupported.
Before returning a start command, it inspects the exact stopped container and
checks image/ownership identity, command, non-root user, init, namespaces,
capability removal, privilege barrier, mounts, network and resource settings.
Mismatches refuse launch and attempt removal of only the owned generation.
This verifies the trusted daemon's configuration; it does not attest an
untrusted daemon, administrator, image or kernel.

## Install and build boundary

Protected profiles accept preinstalled immutable images or already materialized
source. FLUJO does not offer a protected in-app source installer. Selecting an
owner, trusted-host or isolation policy (even an empty/unreadable policy), worker
mode, or an explicit execution profile refuses in-app GitHub preparation and
MCP Install/Build actions before repository code runs. Materialize and inspect
the source outside FLUJO, then review and approve its runtime identity, or use an
already installed immutable container image. Removing a profile is not consent
to run its installation scripts on the host.

Unconfigured native localhost installations retain their existing host installer.
GitHub preparation and Install/Build subprocesses receive an explicit toolchain/OS environment,
plus only server values deliberately supplied to the Install/Build action.
Ambient provider keys, FLUJO tokens, npm authentication and loader controls are
excluded. This is credential scoping, not a sandbox: an explicitly trusted host
installer retains host filesystem/network access, including configuration files
under HOME. Source review never runs candidate hooks, installers or entrypoints.

## Conformance and unsupported modes

| Platform/install mode | Protected isolation status |
| --- | --- |
| Windows source checkout with local Docker Desktop Linux engine, `runc` and supported limits | Real container grant/denial, both SDK discovery/dispatch/revocation and owned cleanup probes exercised |
| Linux containers used by that engine | Non-root/capability/privilege, filesystem, no-egress, cgroup observations, PID-exhaustion refusal and memory OOM termination exercised inside the actual Linux boundary |
| Native Linux host installation | Implementation available; independent host/install qualification is not established; unsupported as a qualified deployment |
| Published npm, official application image, packaged worker and Windows installer | Protected-profile installed-artifact qualification is not established; unsupported as qualified isolation deployments |
| Native Windows containers, rootless Docker, non-`runc` runtimes, remote daemons, absent resource controls | Unsupported; refused by policy/admission |
| Image pulls/builds and source-install lifecycle scripts under a protected profile | Unsupported; refused rather than executed on the host |
| Writable grants, nested host mounts, destination-specific egress and host brokers for isolated servers | Unsupported by the strict v1 profile |

Unsupported deployment status is not a claim that a package cannot start. It
means these source checks do not establish that deployment's enforcement. Do
not advertise it as qualified isolation until its installation and runtime
negative controls have been exercised.

Container shutdown removes the exact ID only after matching its generation and
observes absence. Attach-client exit alone is insufficient. Unobserved cleanup
is `unknown`, retains reconciliation state and blocks replacement. Docker init
reaps descendants while the server remains available. Startup orphan recovery
and continuous mid-call revocation are separate lifecycle work; this contract
checks authority at launch and dispatch and never retries an uncertain tool call.

The optional [source review engine](../guides/mcp-security-review.md) is assistive.
Its fixed SkillSpector clean/poisoned fixtures, non-README threat, manifest-free
MCP source, offline coverage warnings, candidate non-execution, cancellation and
owned cleanup have an executable local acceptance command. Static findings do
not certify dependency/CVE completeness, grant capabilities or control a remote
operator. The configured-model assessment in #101 remains separate.

See the [consent contract](mcp-execution-consent-v1.md),
[container integration](mcp-isolation-integration-v1.md), and Docker's
[recursive bind mount](https://docs.docker.com/engine/storage/bind-mounts/#recursive-mounts)
and [environment](https://docs.docker.com/reference/cli/docker/container/run/#env)
documentation for the underlying controls.
