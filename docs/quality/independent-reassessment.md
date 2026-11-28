# Release reassessment (#578)

The [external audit](https://github.com/mario-andreschak/FLUJO/issues/563) graded
FLUJO on nine rows. [#578](https://github.com/mario-andreschak/FLUJO/issues/578)
asks for evidence tied to one exact release and a fresh assessment of all nine
rows, with A− or better on each before epic #563 can close.

The reassessment no longer waits for anyone. After every npm release,
`.github/workflows/release-evidence.yml`:

1. starts the full pull-request checks and the scorecard source checks on the
   release tag;
2. runs the 28-day offline Persona soak on the release commit;
3. collects the [release evidence page](release-evidence/README.md);
4. runs the automated reviewer, `scripts/release-reassessment.mjs`, which checks
   every acceptance point of #578 and the A− criteria of each row, and records a
   verdict with its evidence;
5. attaches both pages to the GitHub release.

A row reaches A− only when every check behind it is met. A check that needs
people, elapsed time or money reads where its result is recorded (see "What code
cannot supply") and stays "Not met" until it exists. Nobody is asked to run it.

## Latest result: release 3.48.10

Pages: [evidence](release-evidence/v3.48.10.md) ·
[reassessment](release-evidence/v3.48.10.reassessment.md). Assessed on
2026-11-28 at the release commit `174ffaf0`.

| #578 acceptance point | Verdict for 3.48.10 | On the cleanup bundle (next release) |
| --- | --- | --- |
| Evidence is reproducible, redacted, tied to the release commit, and keeps source tests, shipped-artifact checks, simulations, live runs and human use apart | **Met** | Met |
| No open critical regression or unresolved high-severity finding | **Not met**: 3 critical and 28 high code-scanning alerts were open when it shipped, with no written reasons | Fixed or reasoned: all 77 open alerts have a fix or a current written reason; they close on GitHub once the bundle is released and scanned |
| All nine rows at A− or above | **Not met**: 0 of 9 | Not met: 0 of 9 (see the rows below) |
| Product-fit, feature and docs grades kept without marketing claims or hidden scope cuts | **Met** | Met |
| Experimental capabilities and unsupported profiles visible | **Not met**: the project status page did not mark Meetings and Waves as experimental, and the README never said shared or team use is not supported | **Fixed** in this bundle |

| #578 scope item | Verdict for 3.48.10 | On the cleanup bundle |
| --- | --- | --- |
| Source, npm, image and installer provenance; full CI; installed-artifact checks | Not met: the full checks never ran on the release commit, the SBOM was not on the release page, no installed-artifact checks in the release workflows, installer not code-signed | Release workflows now run the installed checks (#570), attach the SBOM (#565) and start the full checks (this change). Code signing is still missing |
| Full offline soak and validator pass at the assessed commit | Not met: never run on 3.48.10 | Runs on every release now; see "The offline soak" below |
| Live runs with real models (bounded smoke, then 7 and 28 days) | Not met: not allowed, the contract's spend limit is 0 USD | Unchanged; Personas stay marked experimental |
| README, project status and security docs follow the evidence | Not met: no scorecard status page at the release commit | Met |

## The nine rows

"Machine verdict" is what the reviewer script reports for 3.48.10. "Grade today"
is this review's judgment, with the reasons; it is not higher than the evidence
allows.

| Row | Audit | Machine verdict | Grade today | Why | What would raise it |
| --- | --- | --- | --- | --- | --- |
| Idea / product fit | A− | A− not confirmed (2 of 3 checks not met) | A− (not confirmed) | MCP-first local hub is still a real niche and no claim overstates it. But no one outside the project has recorded repeated use: the pilot sheets are empty, and 1 outside person merged a change in 90 days | Ten pilot users for eight weeks and 8 of 10 new users finishing a first run within 15 minutes, recorded in the pilot sheets |
| Feature surface | A− | A− not confirmed (1 of 3) | A− (not confirmed) | Every audited feature is still in the README and the release CI passed (13,473 of 13,486 tests, 0 failed). The installed npm, image and installer forms were not exercised by 3.48.10's release workflows | The next release passes the installed checks the bundle adds to all three release workflows |
| Engineering discipline | B+ | Below A− (5 of 6 not met) | B+ | Strong: every shipped byte carries a signed build record naming one commit, and the evidence page proves it. Weak: `main` accepts merges with 0 approvals and 0 required checks, the full checks were started by hand and never ran on the release, no named security responder | Required checks on `main`; full checks on every release (now automatic); a responder and backup named in SECURITY.md |
| Code health | B− | Below A− (3 of 4 not met) | B− | Lint exceptions fell from 802 to 635 on the bundle, but the audit's hot spots grew: runFlow.ts 4,048 lines, ModelHandler.ts 5,274, mcp/index.ts 4,294 on the bundle (3,540 / 4,375 / 3,577 when the split was planned). No one outside the project has changed the core | The #571 split lands and the hot spots shrink below their planned sizes; a second person changes the execution or MCP core |
| Security | C+ | Below A− (4 of 4 not met) | C+ | 3 critical and 28 high alerts were open at release; the installer has no Windows code signature; no outside security review exists. On the bundle every open alert has a fix or a written reason, and one more real alert found here was fixed | A release with no open critical or high alert; a code-signed installer; a published outside review listed in SECURITY.md |
| Maturity / stability | C | Below A− (3 of 4 not met) | C | No soak and no installed recovery checks ran for 3.48.10; no live runs are allowed; Personas, Meetings and Waves stay experimental | A release whose soak and installed recovery checks pass (both automatic now); live runs need an authorized budget |
| Community / bus factor | D | Below A− (3 of 3 not met) | D | 429 pull requests merged in 90 days, 1 from someone outside the project; 2 accounts can write, both the project's own | Two more people with write access who have done a release and recovery drill; three outside contributors in 90 days |
| Docs honesty | A | A not confirmed (2 of 4 not met) | A− for 3.48.10, A on the bundle | No unsupported claim, and the evidence page is exact. But at 3.48.10 two limits were not shown where readers look (Meetings and Waves not marked experimental in the project status; shared use not named as unsupported in the README), and there was no status page | Fixed in the bundle; the docs check now runs on every push |
| Production readiness | C− | Below A− (3 of 3 not met) | C− | Single owner only; shared or team use is deferred (#212); installed checks absent from 3.48.10's release; installer unsigned | Installed checks passing on a release (automatic now); a signed installer; #212 for shared use |

**Overall:** no row can be shown at A− today, for 3.48.10 or for the bundle.
#578's own rule keeps epic #563 open while any row is below A−.

## What this review fixed

- **Experimental limits not shown.** `docs/project-status.md` now marks Meetings
  and Waves as experimental and names shared or team use as not supported; the
  README says the same. `scripts/check-docs-claims.mjs` (run in CI through
  `npm run test:checks`) keeps it that way and also stops "production-ready" style
  claims and silent feature removals.
- **One more high alert without a reason.** Code-scanning alert #433 (a file race
  in a test fixture, `__tests__/mcp/fixtures/trustedHostFingerprint.ts`) had no fix
  or reason. The fixture now reads each file through one open handle, with the same
  fingerprint as before; `alert-triage.json` records it until the next scan.
- **Hand steps in the release checklist.** Starting `verify-full.yml`,
  `scorecard-source.yml` and the soak by hand, collecting the page and finding a
  reviewer are now one workflow that runs after every release.
- **Code signing checked by hand.** The collector now reads the installer's
  Authenticode slot itself: 3.48.10's installer has no signature.
- **Leaks.** The collector refuses to write evidence that holds a key, token,
  password or e-mail address; the committed pages are scanned on every run.

## The offline soak

The full 28-day Persona soak (20 activities a day, seed 459, learning on) and its
validator are the contract's offline gate. It last passed in CI on 2026-10-25 and
never ran on 3.48.10. This review ran it on the bundle:

- On this Windows machine (shared by about a dozen agent sessions), it stopped on
  simulated day 1: "Dispatch batch ... pump exceeded 30000 ms of wall-clock time".
  A shorter run showed each step finishing normally but slowly; the same 30-second
  limit per batch holds on the Linux runner the contract names.
- On Linux (WSL, like the CI runner), the result is in the #578 status comment of
  2026-11-28.

From the next release on, the workflow runs the soak on the release commit and the
reassessment page shows its numbers (worst daily append p95, peak memory, growth).

## What code cannot supply

These checks stay "Not met" until people, time or money provide the result. Each
check reads the place named here after every release; nothing else has to happen.

| Missing | Check | Where the result is read |
| --- | --- | --- |
| Ten weekly pilot users for eight weeks; 8 of 10 new users finishing within 15 minutes | `pilot-weekly-users`, `pilot-first-run` | `docs/pilots/product-fit/tracking-sheet.csv`, `first-run-sheet.csv` |
| Three outside contributors in 90 days | `outside-contributors` | Merged pull requests on GitHub |
| Two backup maintainers | `backup-maintainers` | Write access on GitHub |
| A second person changing the core | `second-human-core-change` | Git history of `src/backend/execution` and `src/backend/services/mcp` |
| Security responder and backup | `security-responder` | The `Security responders:` line in SECURITY.md |
| Outside security review | `independent-security-review` | A list item under "Independent security review" in SECURITY.md |
| Windows code signature | `installer-code-signing` | The installer on the release page (needs a paid certificate with identity checks) |
| Checks required before merging to `main` | `merge-gate` | GitHub rules for `main` (the owner chose fast merges; see [main merge rules](../security/main-merge-rules.md)) |
| Live runs with real models | `live-runs` | Not allowed while the contract's spend limit is 0 USD |
| Shared or team use | `shared-profile` | Deferred by the owner (#212) |

## Who reviewed

This review was done on 2026-11-28 by an AI agent session that did not write the
code under review, using only public data and the repository. It is not the human
outside opinion the audit asked for, and the pages say so. If an outside person
reviews a release, their report goes on #578 unchanged, any disagreement is
recorded here, and a disagreement keeps #563 open.

## Commands this review ran

```sh
npm run evidence:release -- --version latest --out docs/quality/release-evidence      # 22 OK, 4 missing, 1 needs attention, 0 contradictions
npm run reassess:release -- --evidence docs/quality/release-evidence/v3.48.10.json --source v3.48.10 --out docs/quality/release-evidence
npm run reassess:release -- --evidence docs/quality/release-evidence/v3.48.10.json --source <bundle commit>   # the "cleanup bundle" column
npm run check:docs-claims          # found the three missing limits, then passed
npm run check:security-response    # 77 open alerts, all with a current written reason
node scripts/run-persona-soak.mjs --days=28 --activities-per-day=20 --with-learning --seed=459 --commit=<bundle commit>
```

## Rerun it

```sh
npm run evidence:release -- --version <x.y.z> --out docs/quality/release-evidence
npm run reassess:release -- --evidence docs/quality/release-evidence/v<x.y.z>.json --source v<x.y.z> --soak <soak-artifacts> --out docs/quality/release-evidence
```

Or start `release-evidence.yml` with the version; it does all of the above and
attaches the pages to the release.
