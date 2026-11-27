# Release sweep

After a release, the sweep uses the released FLUJO the way a person would. It
walks every page in the [feature map](feature-map/README.md), follows the steps
written there, and reports what breaks. It only reports: it never changes code
and never opens pull requests.

## What it does

1. Installs the published `flujo-ai` package from npm into a new temporary
   folder (or starts a local build). FLUJO's data, home folder and temporary
   files all stay inside that folder.
2. Before it touches anything, it asks the running FLUJO where its data lives
   (`/api/cwd`) and stops if that is not the temporary folder. It also refuses
   port 4200, the everyday FLUJO.
3. Walks the feature map in the order of the list in
   `docs/feature-map/README.md`. Every driving step written in the sweep's
   grammar (see "Steps the release sweep can run" in that README) becomes one
   check, run in a fresh browser session. Steps that need something a fresh
   FLUJO does not have (an AI model, a saved agent) or that are prose only are
   listed as "not covered", never guessed.
4. Gives each check at most 3 minutes and each page at most 10 minutes. A
   failure saves a screenshot and an accessibility snapshot.
5. Writes `report.json` and `report.md`, then stops FLUJO and deletes the
   temporary folder (the last 400 log lines are kept with the report).

Exit codes: `0` every runnable step passed, `1` the sweep found problems, `2`
the sweep could not run (FLUJO did not install or start, no browser, wrong
options).

## Run it on your machine

```
npm run build:mcp                                  # once per checkout
npm run drive -- launch                            # a throwaway FLUJO for this checkout
npm run release:sweep -- --only settings,help      # leave out --only to walk every page
npm run drive -- stop
```

Other targets:

- `npm run release:sweep -- --launch` starts and stops its own instance of this
  checkout (`--mode start` after `npm run build`).
- `npm run release:sweep -- --release 3.48.10` installs that published version
  from npm and sweeps it.

The report goes to `flujo-drive/evidence/release-sweep/<version>-<time>/` in
your cache folder (`%LOCALAPPDATA%` on Windows, `~/.cache` elsewhere), outside
the repository. In dev mode the sweep loads each page once first, so slow
first compiles do not count as failures.

## From problems to issues

```
npm run release:sweep:issues -- --report <report folder>/report.json
```

This plans one GitHub issue per distinct problem, prints the plan and writes
`issues-plan.md` next to the report. It is a dry run: nothing is filed. Add
`--file` to file for real (needs `gh` signed in).

- Each problem gets a fingerprint from the page, the step, the action that
  failed and the kind of error, not the exact wording, port or ids. The same
  failure in the next release has the same fingerprint.
- An open issue with that fingerprint gets one "seen again" comment per
  release, never two.
- A browser error seen on many pages is one issue. If FLUJO stops answering
  during the sweep, that is one issue and the remaining checks are "not run".
- At most 10 new issues per run (`--max-new`); the next run files the rest.
- When filing, it stops if it cannot read the open issues, so it never files
  duplicates.
- Issues get the labels `release-sweep` and `classification: BUG`. Each one
  says that either FLUJO broke or the feature map step is out of date, and
  shows the step, the error, the start of the accessibility snapshot and where
  the screenshot is.

## In GitHub: built, switched off

`.github/workflows/release-sweep.yml` runs after every successful "Publish npm
release" run, but only while the repository variable `RELEASE_SWEEP` is set:

- `report`: sweep, show the planned issues in the run summary, file nothing.
- `file-issues`: sweep and file the issues.

It has two jobs. `sweep` installs and drives the released FLUJO with read-only
permissions. `report` files issues and never installs or runs FLUJO.
`assertReleaseSweepReportsOnly` in `scripts/workflow-contract.mjs` keeps it that
way. You can also start it by hand under Actions → "Release sweep" → "Run
workflow" with a version; it files issues only if you tick "File GitHub issues".

GitHub does not start a workflow from a release that another workflow created
with its own token, so the sweep waits for the "Publish npm release" run to
finish instead of listening for the release itself.

### Switch it on (one step)

```
gh variable set RELEASE_SWEEP --body report --repo mario-andreschak/FLUJO
```

After a release or two with sensible reports, set it to `file-issues`. To
switch it off again: `gh variable delete RELEASE_SWEEP --repo mario-andreschak/FLUJO`.

## As a scheduled Claude task instead

To sweep on your own machine, for example once an AI model can be connected
for the steps that need one, a scheduled Claude task can run this prompt after
each release:

```
Run the FLUJO release sweep for the newest published release. Work in a fresh clone of
mario-andreschak/FLUJO on main in a temporary folder, never in an everyday checkout, and never
use port 4200.
1. Get the newest release with `gh release view --json tagName` and drop the leading "v".
2. In the clone run `npm ci`, then `npm run release:sweep -- --release <version>`.
3. Run `npm run release:sweep:issues -- --report <the report.json it printed>` and read the plan.
4. Only if `gh variable get RELEASE_SWEEP` prints `file-issues`, run step 3 again with `--file`.
5. Never change code, open pull requests or close issues. Delete the clone when done.
Answer with the report summary and the links of any issues filed.
```

## Fix pull requests come later

Agents that open fix pull requests for every report would mostly add noise.
Allow them only after the reports have been right for several releases, that
is, few issues closed as "feature map out of date" or as not a problem. That
takes a deliberate change to `assertReleaseSweepReportsOnly`, not a quiet edit
to the workflow.
