# Release sweep

After every release, the sweep uses the released FLUJO the way a person would.
It walks every page in the [feature map](feature-map/README.md), follows the
steps written there, and files one GitHub issue for each real problem. Nobody
has to start it or switch it on. It only reports: it never changes code and
never opens pull requests.

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
4. A step that fails runs once more in a fresh browser. It counts as a problem
   only if it fails again; one that passes the second time is listed in the
   report as "passed on the second try" and not filed. A step that keeps doing
   this fails twice in some later sweep and gets its issue then.
5. Saves a screenshot and an accessibility snapshot for every failure, writes
   `report.json` and `report.md`, then stops FLUJO and deletes the temporary
   folder (the last 400 log lines are kept with the report).

Exit codes: `0` every runnable step passed, `1` the sweep found problems, `2`
FLUJO could not be installed or started, `3` the sweep machine failed, so the
run says nothing about FLUJO.

## Safe by default

- **Time.** Each check gets at most 3 minutes, each page 10 minutes and the
  whole sweep, install included, 60 minutes (`--total-timeout`). Steps it does
  not reach in time are listed as "not run" and the report is still written;
  the next release's sweep starts from the top again. Each GitHub job also has
  its own time limit, so a stuck run ends on its own.
- **The sweep machine's own failures are never filed.** Running out of disk,
  memory or file handles, npm not reaching the registry (or a release that has
  not reached it yet), and the sweep's browser dying or not starting are
  recognised from the error. They are retried (npm three times, starting over
  in a new folder up to three times, a check up to two more times with a
  restarted browser) and, if they persist, listed in the run summary under
  "Caused by the sweep machine". FLUJO running out of its own memory or
  crashing still counts as FLUJO.
- **At most 5 new problem issues per run.** More problems than that go into one
  summary issue that lists them with their fingerprints. Problems that already
  have an issue only get a comment and do not count, so each following sweep
  opens issues for the next 5 waiting problems that still happen. When a sweep
  has walked every page and nothing is left waiting, it closes the summary
  issue. A run therefore opens at most 6 issues.
- **Nothing twice.** Every issue carries a hidden fingerprint, and every comment
  a hidden "seen in version" mark, so running the same release again adds
  nothing. When the existing issues cannot be read (after four tries with
  growing pauses), it files nothing. A write that fails is not repeated in the
  same run (GitHub may have done it anyway); the next sweep does what is
  missing.

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
the repository. In dev mode the sweep first loads each page and opens it once
in the browser, so slow first compiles do not count as failures. Dev mode still
needs plenty of free memory; on a busy machine prefer `--release` or
`--launch --mode start`.

## From problems to issues

```
npm run release:sweep:issues -- --report <report folder>/report.json
```

On your machine this only plans: it prints the issues it would file and the
comments it would add, and writes `issues-plan.md` next to the report. The
GitHub workflow adds `--file` and files them.

- Each problem gets a fingerprint from the page, the step, the action that
  failed and the kind of error, not the exact wording. Ports, ids, numbers,
  build hashes and the short names a production build gives variables are left
  out, so the same failure in the next release has the same fingerprint. Tests
  pin the fingerprint, because changing it would lose track of every open
  sweep issue.
- An open issue with that fingerprint gets one "seen again" comment per
  release.
- A closed issue with that fingerprint:
  - closed as "not planned" keeps the problem quiet until someone reopens it;
  - closed after the swept release was made (the commit of its `v<version>`
    tag) gets a comment instead of a new issue, because that release cannot
    hold the fix yet; if the date cannot be found, it also gets a comment, so
    nothing is filed twice;
  - closed before that means the problem came back: a new issue links the old
    one.
- A browser error seen on many pages is one issue. If FLUJO stops answering
  during the sweep, that is one issue and the remaining checks are "not run".
- Issues get the labels `release-sweep` and `classification: BUG`. Each one
  says that either FLUJO broke or the feature map step is out of date, and
  shows the step, the error (and the second try's), the start of the
  accessibility snapshot, a command that repeats the check on that release,
  and a direct link to the screenshot and snapshot files. GitHub's built-in
  token cannot put pictures into issues, and hosting them in the repository
  would need write access to the code, which the sweep must never have; the
  text snapshot shows what the screen held, and the files stay downloadable
  for 90 days.

## In GitHub

`.github/workflows/release-sweep.yml` runs after every successful "Publish npm
release" run and files the issues. It needs nothing but the built-in
`GITHUB_TOKEN`; no secret, variable or setting.

It has two jobs. `sweep` installs and drives the released FLUJO with read-only
permissions. `report` files issues (`issues: write`) and never installs or runs
FLUJO. You can sweep an older version again under Actions → "Release sweep" →
"Run workflow"; it behaves exactly like the automatic run.

GitHub does not start a workflow from a release that another workflow created
with its own token, so the sweep waits for the "Publish npm release" run to
finish instead of listening for the release itself.

Two checks in `scripts/workflow-contract.mjs` keep the workflow this way:
`assertReleaseSweepReportsOnly` (it may write nothing but issues) and
`assertReleaseSweepRunsByDefault` (it starts after every release, files on
every run, depends on no variable or secret and has time limits).

## From issue to fix

Sweep issues are ordinary bug issues. They are fixed the way every FLUJO issue
is: an agent session takes the issue, changes the code or the out-of-date
feature map step, and the pull request goes through the usual checks and
verification. The sweep itself never writes code: an automatic fix from the
workflow would need a model key in the repository's secrets and write access to
the code, and both would break the rule that the sweep needs only the built-in
token and can only report.
