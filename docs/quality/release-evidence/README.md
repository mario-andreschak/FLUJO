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
- the Windows installer checksum, its evidence file, its signed build record and
  whether it carries a Windows code signature (Authenticode);
- the dependency lists (SBOMs): signed, and whether they are attached to the
  release page;
- how many security alerts were open when the release was published, and now;
- a list of everything that is missing or could not be checked, with the reason.

Each release also gets a **reassessment page**: an automated reviewer goes
through every acceptance point of #578 and the A− criteria of the nine scorecard
rows, and records a verdict with its evidence for each.

| Release | Evidence | Reassessment | Collected |
| --- | --- | --- | --- |
| 3.48.10 | [v3.48.10.md](v3.48.10.md) | [v3.48.10.reassessment.md](v3.48.10.reassessment.md) | 2026-11-28 |

## After every release, nobody has to start anything

`.github/workflows/release-evidence.yml` runs when `Publish npm release` succeeds:

1. it starts the full pull-request checks (`verify-full.yml`) and the scorecard
   source checks (`scorecard-source.yml`) on the release tag;
2. it runs the 28-day offline Persona soak (seed 459, learning on) on the release
   commit, with the soak's own validator;
3. it waits for the checks (at most four hours), collects the evidence page,
   writes the reassessment page and attaches both to the GitHub release, with
   their JSON and saved answers.

Pages for other releases live on their release page; commit one here when a
person or agent wants it kept in the repository (`--out docs/quality/release-evidence`).

## Collect a release

```sh
npm run evidence:release -- --version latest --out docs/quality/release-evidence
npm run evidence:release -- --version 3.48.10 --out docs/quality/release-evidence
```

This writes three files (the reassessment adds `v<version>.reassessment.md` and
`.json`, see below):

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

Commit pages for minor releases and for releases someone reviews, not for every
daily patch release; each release adds about 150 KB. Every release still gets
its pages attached to its release page by the workflow.

## Reassess a release

```sh
npm run reassess:release -- --evidence docs/quality/release-evidence/v3.48.10.json --source v3.48.10 --out docs/quality/release-evidence
npm run reassess:release -- --replay docs/quality/release-evidence/v3.48.10.reassessment.json
```

`--source <git ref>` reads the docs, workflows and contract of that commit with
`git show`, so the verdicts describe the release and not today's checkout.
`--soak <folder>` adds the Persona soak artifacts for the same commit. The
reviewer also reads a few public GitHub facts (open critical issues, open
code-scanning alerts, merged pull requests by people outside the project,
accounts with write access, merge rules on `main`); people are stored as counts,
never names. Every input is saved in `v<version>.reassessment.json`, and
`scripts/release-reassessment.test.mjs` judges each committed page again from it.

A check that needs people, elapsed time or money reads where its result is
recorded and stays "Not met" until it exists:

| Check | Where its result is recorded |
| --- | --- |
| Pilot users and first runs | `docs/pilots/product-fit/tracking-sheet.csv`, `first-run-sheet.csv` |
| Outside contributors, backup maintainers | Merged pull requests and write access on GitHub |
| Security responder and backup | The `Security responders:` line in `SECURITY.md` |
| Outside security review | A list item under "Independent security review" in `SECURITY.md` |
| Live runs with real models | Not allowed: the contract's spend limit is 0 USD |
| Shared or team use | Deferred (#212) |

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
  commands that do. For the installer it reads whether a Windows code signature
  is present, not whether its certificate is trusted.
- It refuses to write a page that contains a key, a token, a password or an
  e-mail address.
- CI and test results are for the source on the release commit. Installed use
  of the npm package, image and installer is checked separately (#570, #572).
- Human use, outside contributors and long real-model runs are outside it
  (#576, #577 and the [scorecard foundation contract](../scorecard-foundation.md)).

The [reassessment page](../independent-reassessment.md) records the latest
review: the verdict per criterion, the grades and what is still missing.
