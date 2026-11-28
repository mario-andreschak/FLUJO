# CI runtime identity and qualification

The supported application and MCP runtime policy is exported by
`bin/node-runtime.mjs`: `^22.23.4 || ^24.22.1`. The package engine declarations,
launchers, installers and automatic updater must agree with that policy.

| Profile | Exact Node | libuv |
| --- | --- | --- |
| Supported 22 | 22.23.4 | 1.51.0 |
| Supported 24 | 24.22.1 | 1.52.1 |
| Historical build only | 22.13.1 | 1.49.2 |

Minimum and current profiles coincide on each supported line. Historical Node
22.13.1 is restricted to its original build comparison and is not supported for
a new installation or release.

## Shipped runtimes

`shipped` in `scripts/ci-node-binaries.json` names the Node version FLUJO
ships, once for the installers and once for the container image:

| | Node | Where |
|---|---|---|
| Installers | 24.22.1 | private Windows runtime in `scripts/install.ps1`; NodeSource, Homebrew, zypper and pacman in `scripts/install.sh` |
| Container image | 24.22.1 | both stages of `Dockerfile` |

`scripts/verify-ci-node.test.mjs` fails when one of these files names another
version or Node line, when the Windows archives' checksums are not in the
signed checksum file of that version, or when the container ships another Node
line than the installers without a reason in `containerBehind` (and when that
reason stays after both match).

### Container base

`containerBase.observed` records what Docker Hub's official `library/node`
repository published for the base tag (`metadataUrl`): the tag, the
multi-platform index digest the `Dockerfile` pins, its linux/amd64 image and
when it was pushed. `containerBaseRecord` in `scripts/verify-ci-node.mjs`
refuses a base that is not that observation of the shipped container Node.
Each build pulls exactly that digest, and each stage checks its Node binary
against the signed release before anything else runs.

To move the base (a new Node release or a Debian security rebuild), read
`https://hub.docker.com/v2/repositories/library/node/tags/<version>-bookworm-slim`,
copy `name`, `digest`, `media_type`, `tag_last_pushed` and the linux/amd64
entry of `images` into `observed`, set `observedAt`, then change both `FROM`
lines. The container smoke re-reads the index from the registry and checks its
bytes against the recorded digest and linux/amd64 image.

## Container smoke

`scripts/smoke-container-image.mjs` checks a built image the way it ships, on
1 CPU and 2 GB (the size of the small cloud machine a voice app runs FLUJO on):

1. The image runs the shipped container Node, from the recorded official base.
2. The container starts, its own `HEALTHCHECK` passes and the published port
   answers.
3. `scripts/container-smoke/inside.mjs first-chat` runs inside the container: a
   stand-in OpenAI-compatible model answers a first chat through a flow
   (streamed and not) and a direct model call, and the chat is stored.
4. `inside.mjs voice` is the voice-app check that used to need a real Claude
   token on that machine. A Claude subscription model runs through the bundled
   Claude Code, which sends its model requests to a stand-in of Anthropic's
   Messages API (`ANTHROPIC_BASE_URL`) with a placeholder token, and one MCP tool
   comes from a stand-in MCP server. Four direct calls, four tool turns and four
   turns of one continued conversation run on the path every install uses
   (since #1449 the ready Claude process, the reused MCP lists and the fewer
   saves per turn are always on). The check judges what FLUJO and the
   stand-ins observed, never timings (a busy machine scatters them), against
   fixed limits from the #1408 measurements, as the median of the later runs
   (`VOICE_LIMITS` in `inside.mjs`): a Claude Code process waits ready and at
   least two of three later direct calls and tool turns take one (FLUJO's step
   timer marks `claude.claimed`; a continued turn resumes its Claude session
   and starts its own process), a tool turn sends at most one MCP list request
   and saves the conversation at most 3 times, and a continued turn saves it
   at most 2 times. Every finished turn must be stored. The times are
   reported, not judged.
5. The container is killed (`docker kill`) and started again; every finished
   turn must still be there and both models must still answer.

Nothing leaves the machine except the registry read in step 1. The report
(`--report`) holds every check and the voice timings; CI shows them in the job
summary and keeps the report as an artifact. The `test` job of `verify.yml`
builds the image from every main-target change and runs the smoke, and
`publish-image.yml` runs it on the exact image before pushing it.
`assertContainerSmoke` in `scripts/workflow-contract.mjs` keeps both in place.

To run it locally with Docker:

```sh
docker build -t flujo-container-smoke:local .
node scripts/smoke-container-image.mjs --image flujo-container-smoke:local --report "$PWD/container-smoke.json"
```

## Verify the executable before running build tools

Every direct CI Node setup must be immediately followed by the mandatory
`scripts/verify-ci-node.mjs` guard, before dependencies or application commands.
For example, after selecting exact Node 22.23.4:

```sh
node scripts/verify-ci-node.mjs 22.23.4 --record
```

The verifier checks the actual executable's SHA-256, exact version, libuv,
platform and default heap against `scripts/ci-node-binaries.json`. It refuses
unlisted binaries, moving version selections, heap overrides and mismatched
profiles. Runtime records are generated outputs and belong in the CI artifact
directory or an external local results directory.

The manifest also pins the container base by digest. Container packaging must
retain the same runtime verification and the canonical startup guard. A matching
Node executable does not establish application or installed-container acceptance.

## Historical trust inputs

The manifest's checksum and signature provenance comes from the official
[Node release keys](https://github.com/nodejs/release-keys) at immutable commit
`481637f813e912c4aa3622d7964ab426c97b8e8d`. Linux executable and libuv hashes
were derived from the fixed members of archives checked against signed
checksums; Windows hashes come from the signed `win-x64/node.exe` entries.

Raw run records are not shipped in the current tree. The manifest's
`archivedSourceRevision` identifies their unchanged historical Git snapshot.
`scripts/verify-ci-node.test.mjs` reads those inputs through the bounded
`scripts/read-archived-fixture.mjs` helper. It retains the checksum, signature,
key-source, executable-derivation and bad-signature assertions. These source
regressions require full repository history and never download missing inputs.
The live executable verifier itself needs only the current manifest.

## Release qualification

During development, run local typecheck and lint, plus the inspected non-container
application build before committing. Full CI, packed-process acceptance,
installer/container builds, security scanners and broader regression suites are
release pre-flight checks. Automatic verification on merge remains paused.

Release validation must cover both supported runtime lines and declared operating
systems, actual packaged-process startup and refusal, MCP payloads and typechecks,
workflow/release contracts, and the existing security regressions. Keep exact
source/artifact identity and runtime records with the external release results.
Do not substitute historical source checks for a new release's acceptance.

GitHub action runtimes are separate from the application runtime. Keep pinned
official action revisions and their runner requirements aligned with the
workflow contracts. A workflow file alone cannot change the live branch ruleset.

The immutable 8fe exporter remains inert under its event and ancestry guards.
Its patched setup refuses the old source verifier and needs separate
requalification before future activation.
