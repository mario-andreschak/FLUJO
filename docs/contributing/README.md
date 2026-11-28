# Contributing to FLUJO

This guide takes you from nothing to a first pull request. You do not need an AI
account, a paid service, private files or an existing FLUJO installation.

Last walked through step by step on **Windows 10, November 25, 2026** (Node.js
22.23.4, npm 10.9.9, Git 2.47). Times below are from that machine. If a step is
wrong on your system, fixing this page is a welcome first pull request
([#1441](https://github.com/mario-andreschak/FLUJO/issues/1441) asks for a
Linux or macOS check).

## What you need

- **Node.js 22.23.4 or newer 22.x, or 24.22.1 or newer 24.x**, with the npm that
  comes with it. The app and the test runner refuse older versions with a message
  that explains how to update.
- **Git.**
- About **2 GB of free disk space** (the installed packages take 1.4 GB).

Check what you have:

```sh
node --version
npm --version
git --version
```

To install or update Node.js, use [nodejs.org](https://nodejs.org/en/download),
`nvm install 22` (Linux or macOS with nvm), or on Windows
`winget install --id OpenJS.NodeJS.22 --exact --source winget`.

On Windows you may have more than one Node.js installed. `Get-Command node -All`
lists them; the first one wins. Put the new one first on `PATH`, or open a new
terminal after installing.

## 1. Get your own copy

You cannot push to the main repository, so work in your own copy (a fork):

1. On GitHub, open [mario-andreschak/FLUJO](https://github.com/mario-andreschak/FLUJO)
   and click **Fork**. (With the GitHub CLI: `gh repo fork mario-andreschak/FLUJO --clone`.)
2. Clone your fork and create a branch for your change:

```sh
git clone https://github.com/YOUR-NAME/FLUJO.git
cd FLUJO
git remote add upstream https://github.com/mario-andreschak/FLUJO.git
git switch -c my-first-change
```

Clone the full history (no `--depth`). A few checks read old files from it.
The download is about 300 MB.

On Windows, keep the folder path short (for example `C:\dev\FLUJO`). Some
installed files sit about 150 characters deep, which breaks on systems without
long path support.

## 2. Install

```sh
npm ci --include=dev
npm run build:mcp
```

- `npm ci` installs the exact package versions from `package-lock.json`. It took
  4 minutes. Warnings about deprecated packages are normal.
- `npm run build:mcp` builds the four built-in MCP servers in `mcp-servers/`
  (about 30 seconds). The app and every test that creates a workspace need them.
  If you skip this step, the test runner and `npm run dev` build them for you the
  first time. When a package is still missing, FLUJO names it and tells you to
  run `npm run build:mcp`.

If `npm ci` fails, keep the error and your Node.js, npm and OS versions and open
an issue. Do not copy `node_modules` from another folder or delete the lock file:
the test runner refuses a borrowed install on purpose.

## 3. Check that it works

```sh
npm run test:dependencies
node scripts/run-local-jest.cjs __tests__/scripts/localTestDependencies.test.ts --runInBand
node --test scripts/release-verification.test.mjs scripts/require-release-verification.test.mjs
```

The first command checks your Node.js and your install and finishes in a second.
The second runs one small Jest test file (a few seconds). The third runs 37 small
script tests (under a second). All three must pass.

## 4. Try the app with throwaway data

Never point a test run at the FLUJO you use every day. The easiest way is the
drive tool, which picks a free port and an empty data folder:

```sh
node scripts/flujo-drive.mjs launch
node scripts/flujo-drive.mjs stop
```

`launch` prints the address to open (for example `http://127.0.0.1:4301/`) and
returns once the first page loads; the first start compiles pages and can take a
few minutes. `stop` stops only that instance and deletes the data folder it
created. The tool can also click through pages for you; see the
[feature map](../feature-map/README.md).

To run the development server yourself instead, give it a new empty data folder
and keep it on your own machine:

PowerShell:

```powershell
$contributorData = Join-Path $env:TEMP ('flujo-contributor-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $contributorData | Out-Null
$env:FLUJO_DATA_DIR = $contributorData
$env:FLUJO_EXPOSURE_MODE = 'localhost'
node scripts/launch-next.mjs dev --webpack --hostname 127.0.0.1 --port 4300
```

Linux or macOS:

```sh
export FLUJO_DATA_DIR="$(mktemp -d -t flujo-contributor.XXXXXX)"
export FLUJO_EXPOSURE_MODE=localhost
node scripts/launch-next.mjs dev --webpack --hostname 127.0.0.1 --port 4300
```

Open `http://127.0.0.1:4300` and stop with Ctrl+C. Close that terminal afterwards
so the throwaway settings do not leak into your everyday FLUJO. Do not connect a
real AI account or import a personal backup for a first change.

The November 25 check did not start the app (the machine was shared with other
work), so tell us in an issue if this step does not work for you.

## 5. Make your change

1. Pick a task. Issues labelled
   [`good first issue`](https://github.com/mario-andreschak/FLUJO/labels/good%20first%20issue)
   are small and spell out every step; the [starter list](starter-backlog.md)
   explains them. Comment on the issue to claim it before you start.
2. Read [`AGENTS.md`](../../AGENTS.md). It holds the house rules for people and
   AI agents alike: fix causes, not symptoms; keep slow work off the server's main
   loop; let failures heal themselves instead of blocking until a restart.
3. Find the code and its tests with the [newcomer map](task-map.md).
4. Write a test that fails first, then make it pass. Keep the change small and
   about one thing.

If you change routes or components in `src/app`, read the matching guide in
`node_modules/next/dist/docs/` first. This Next.js version differs from older
tutorials.

## 6. Before you open a pull request

Run the checks for what you touched. You do not need to run everything;
continuous integration (CI) runs the full suite on every pull request.

| You changed | Run |
| --- | --- |
| Any code | The test files for it: `node scripts/run-local-jest.cjs <test files> --runInBand` |
| Any code | Lint only your files: `npx eslint <files>`, then `npm run lint:ratchet` |
| TypeScript | `npm run typecheck` (about 3 minutes) |
| A page in `src/app` | `npm run check:feature-map`, and update its entry in `docs/feature-map/` |
| An API route added or removed | `node scripts/generate-api-inventory.mjs` |
| `mcp-servers/` | `npm run build:mcp` and `npm run test:mcp-process-boundary` |
| Lint rules or repository tools | `npm run test:checks` |

Never add entries to `eslint-suppressions.json`; that list only shrinks. If a
rule really does not fit one line, disable it on that line with a reason:
`// eslint-disable-next-line <rule> -- <why>`.

More test recipes are in the [newcomer map](task-map.md#test-recipes).

## 7. Open the pull request

Push your branch to your fork and open a pull request against `main`. The
template asks for:

- what changes for the user, before and after;
- how you tested it, and what you did not test;
- screenshots for anything visible, using made-up data only;
- `Fixes #123` when it fully solves an issue, otherwise `Refs #123`.

Never include passwords, API keys, session cookies or personal data in code,
issues, pull requests, logs or screenshots.

## How reviews work

- **Who reviews.** Today there is one maintainer, Mario
  ([@mario-andreschak](https://github.com/mario-andreschak)). He reviews and merges
  pull requests from contributors. Most commits in this repository are written by
  AI coding agents that work for him under the `flujo-app` account and merge their
  own work under his standing instructions. Your pull request is reviewed by a
  person.
- **Areas that always need the maintainer.** `.github/CODEOWNERS` lists them:
  security, login, stored credentials, starting MCP servers, install and update,
  releases and the HTTP API. Changes there need a short note on how to undo them,
  and review may take longer.
- **What a reviewer checks.** A test shows the behaviour; the change is focused;
  no new lint exceptions; the rules in `AGENTS.md` hold; nothing private is
  included.
- **Checks.** `main` does not block a merge when CI fails today, so reviewers
  read the CI results themselves. Never weaken a test, skip it, or regenerate
  expected output only to make a check pass. Say which checks you ran and which
  you skipped.
- **Disagreements.** Discuss in the issue with examples. The maintainer makes the
  final call; see [maintainership](maintainership.md).
- **Waiting.** If nobody has answered after a week, add a comment to the pull
  request. That is welcome, not rude.

## Reporting bugs

Include how you installed FLUJO (npm, Windows installer, Docker or source), the
version, your OS, the steps to reproduce, and the error with private details
removed. Report security problems privately as described in
[SECURITY.md](../../SECURITY.md), never in a public issue.

## More

- [Documentation guidelines](documentation-guidelines.md)
- [Maintainership basics](maintainership.md) and the
  [release and recovery drill](maintainer-drill.md), for people who want to help
  maintain FLUJO.
