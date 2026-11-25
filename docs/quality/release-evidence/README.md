# Release evidence

One page per assessed release that shows, in one place, what anyone can check
about it ([#578](https://github.com/mario-andreschak/FLUJO/issues/578)):

- the exact commit and file tree behind the release tag, and whether `main`
  contains it;
- the CI runs on that exact commit and their jobs;
- the test counts from that CI run, next to the floor in `test-baseline.json`;
- the npm packages: integrity hash, registry signatures, npm provenance, the
  SHA-256 of the registry bytes and GitHub's signed build record for them;
- the Docker image digest behind the version tag, with its signed build record;
- the Windows installer checksum, its evidence file and its signed build record;
- the dependency lists (SBOMs): signed, and whether they are attached to the
  release page;
- how many security alerts were open when the release was published, and now;
- a list of everything that is missing or could not be checked, with the reason.

| Release | Page | Collected |
| --- | --- | --- |
| 3.48.10 | [v3.48.10.md](v3.48.10.md) | 2026-11-25 |

## Collect a release

```sh
npm run evidence:release -- --version latest --out docs/quality/release-evidence
npm run evidence:release -- --version 3.48.10 --out docs/quality/release-evidence
```

This writes three files:

| File | What it is |
| --- | --- |
| `v<version>.md` | The page people read |
| `v<version>.json` | The same facts for programs |
| `v<version>.answers.json` | Every answer the collector read from GitHub, npm and ghcr.io, so the page can be rebuilt offline |

Without `--out` the page is printed instead. `--skip-npm-bytes` skips
downloading the npm tarballs (about 15 MB) and marks those checks as not
checked. `--replay v<version>.answers.json` rebuilds the page from saved answers
without the network.

The run takes about a minute. It needs the GitHub CLI (`gh`) signed in. It only
reads; it never changes anything on GitHub, npm or the registry, and it never
reads secrets. Security alert counts need a login that can see the repository's
alerts; without one, those rows say "Not checked" and the rest of the page is
still written. A network hiccup is retried twice; a piece that still cannot be
read is listed under "Pieces that could not be read".

Collect evidence for the release an outside reviewer assesses and for minor
releases, not for every daily patch release. Each release adds about 120 KB.

## What the results mean

| Result | Meaning |
| --- | --- |
| OK | The piece exists and agrees with the release commit |
| Missing | The piece does not exist for this release |
| Needs attention | The piece exists but shows a problem, such as a failed job or open high-severity alerts |
| Does not match | Two pieces contradict each other, for example a signed build record names another commit. The command exits with code 2 |
| Not checked | The collector could not or does not check it; the reason is on the page |

## Keeping pages honest

`scripts/collect-release-evidence.test.mjs` rebuilds every committed page from
its saved answers and fails if the page or its JSON differ. To change a page,
collect it again; never edit it by hand. The same test file uses the saved
3.48.10 answers as fixtures: it changes one answer at a time (another commit in
a signed record, expired test results, an unreadable source, a release that
attaches its SBOM) and checks the result.

## What a page does not prove

- It checks the commit, workflow and file hashes that signed build records name,
  not the cryptographic signatures. Each page lists the `gh attestation verify`
  commands that do.
- CI and test results are for the source on the release commit. Installed use
  of the npm package, image and installer is checked separately (#570, #572).
- Human use, outside contributors and long real-model runs are outside it
  (#576, #577 and the [scorecard foundation contract](../scorecard-foundation.md)).

The [independent reassessment package](../independent-reassessment.md) explains
how an outside reviewer uses these pages.
