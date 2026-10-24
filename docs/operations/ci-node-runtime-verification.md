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
