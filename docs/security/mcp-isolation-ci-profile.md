# Managed MCP container CI fixture

PR #615's two real SDK/container cases previously required a developer's
preinstalled local image and an explicit opt-in. Ordinary hosted CI skipped
them, and approving those skips would leave the runtime wiring unqualified.
This follow-up prepares a local fixture image in the mandatory main CI test job
and enables both tracked cases before Jest. No test baseline, quarantine or
intentional-skip allowance changes are included.

## CI preparation and cleanup contract

`scripts/prepare-isolation-ci-image.cjs` runs on the Linux runner against the
fixed `/usr/bin/docker` and local `unix:///var/run/docker.sock`. It builds `FROM
scratch` using the runner's installed Node executable and its linked libraries.
The dependency listing is bounded and strictly parsed; each canonical regular
file is copied and hashed through one bounded descriptor with exact bigint and
nanosecond identity checks before/after. Short reads/writes are handled. No
registry image, package installation, application payload or host credential is
added. The Dockerfile has only the scratch base, copied runtime, PATH and a
random ownership label. Build uses denied network and no pull.

The generated immutable image ID, runtime byte digests, Node/platform/architecture
and random generation are recorded in `.tmp/mcp-isolation-ci-image.json`.
Preparation supplies the actual test profile through `GITHUB_ENV`, including
`FLUJO_RUN_ISOLATION_SOURCE_PROBE=1`. Missing Docker/build/runtime dependencies
fail preparation instead of skipping the cases. Fixture unit checks run before
preparation. After Jest, image cleanup precedes the assertion baseline gate;
Jest's existing continue-on-error permits cleanup even when tests fail. Cleanup
requires the full image ID and exact ownership label, does not force removal
over a remaining container, verifies image absence, and confines context removal
to its checked owned temp directory. Failed preparation also attempts owned
cleanup and records uncertainty. The receipt is uploaded with Jest results.

The workflow contract rejects omitted fixture checks, omitted setup/cleanup,
out-of-order setup/cleanup, disabling the test profile at the Jest step and a
missing receipt upload. Existing mandatory checks and pinned action versions
remain. This fixture builds only a tiny standalone Node runtime image; it does
not build or publish FLUJO's production image or add a release qualification.

## Exact source context and local controls

The base is root `6390bc017f87724c3e71f2474b5166e886e68ce8` plus separate
replays of #615 and #619:

- managed wiring: `81f871a252cb19ea8540280e12d365b35f25e123`;
- config admission: `14feb35f791bac46c13cffa39c5cca8fcb904318`.

Two factory conflict resolutions preserve #664's strict transport checks before
the isolation branch and preserve explicit stdio selection. Original source
heads remain frozen. This branch does not take #632/#668/#677 or #678. Root must
qualify the combined intake independently; older #615 source evidence is not
borrowed for this composed graph.

Windows Node 22.13.1 with locked Next 16.3.8 passed 120 assertions across eight
focused isolation, lifecycle, receipt and transport-admission suites. The final
script/workflow controls passed 38 Node tests without skips. Primitive/test
TypeScript with Next ambient declarations, all changed/replayed source ESLint
and diff checks pass. Full application graph type/build remains with root.

The actual final runtime assembler ran in the existing immutable Linux image
`sha256:fc8cd9deea7389d01d9a70cc83a5d09465c2050f2ae322d67300a9794433edad`
as UID 65534, with denied network, read-only root/source, dropped capabilities,
no new privileges, 256 MiB memory, 0.5 CPU and 32 PIDs. Its only writable host
grant was the owned ignored output context. The assembler container was confirmed
absent after completion. It copied eight actual runtime files totaling
130,234,256 bytes, using Linux Node 22.23.2. The Node file digest was
`3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327`.
The executed preparation source digest was
`a84656d94a436f35949b60f9c8e73c193031daedab8af14b4d5dd9c5ff12b539`.

The Windows Docker CLI built the resulting scratch context on the local Linux
daemon without network/pulls, producing
`sha256:c7d7fe51b717d70217107aa9eda7b90257b541ad6b977b0125aae91a716726ac`,
generation `aed42fca-fe09-4704-b29a-ab10914b5515`. Both real SDK cases passed
against that image with no skips: classic handshake, paginated discovery,
metadata preservation, actual tool dispatch, non-root/root-write/environment/
memory/OAuth boundary observations, global-secret-reference denial, grant
revocation denial and managed-container removal. Both test-created containers
were absent afterward. This is an actual source/SDK/container journey with
synthetic storage/config boundaries, not an installed Next/browser journey.
The full Linux CLI prepare/GITHUB_ENV/test/cleanup sequence and hosted runner's
own Node/library version remain pending until this follow-up's CI executes.

Local fixture-image/context cleanup is incomplete. Automatic approval review
rejected the combined removal command before execution with `blocked by policy`.
Read-only inspection confirmed both scratch fixture images and both owned
contexts remain, with no containers using them. The final image above and an
earlier control image
`sha256:e88f19e2e6411e87b5d5a1b02f7e71e788c9859eff6e775ab87d3f6a8b47f6c0`
are retained. This does not change the separately observed managed SDK container
removal. No cleanup success is claimed for the local image/context resources.

Default isolation, install/build-command isolation, stable private policy reads,
stream/task lifetime revocation, durable orphan recovery, installed-artifact
controls, human acceptance and independent Security reassessment remain open.
No scanner disposition or completed A- outcome is asserted.
