# Contributing to FLUJO

Thank you for helping. You need Node.js, npm and Git; no AI account.

1. **Set up and make a first change:** the [contributor guide](docs/contributing/README.md)
   (about 10 minutes of steps plus a 4-minute install).
2. **Pick a task:** issues labelled
   [`good first issue`](https://github.com/mario-andreschak/FLUJO/labels/good%20first%20issue),
   explained in the [starter list](docs/contributing/starter-backlog.md).
3. **Find your way around:** the [newcomer map](docs/contributing/task-map.md)
   shows where code lives and how to test it.
4. **Know how reviews work:** see
   [how reviews work](docs/contributing/README.md#how-reviews-work) before you open
   a pull request.

The house rules for people and AI agents are in [`AGENTS.md`](AGENTS.md).
People who want to help maintain FLUJO can read the
[maintainership basics](docs/contributing/maintainership.md) and the
[release and recovery drill](docs/contributing/maintainer-drill.md).

## Security and privacy

Never report an unfixed security problem in a public issue; use the private
report described in [SECURITY.md](SECURITY.md). Never put passwords, API keys or
personal data in issues, pull requests, logs or screenshots.

## Keep the checkout small

Keep generated test output, recordings, AI agent handovers and media projects
outside the repository. Only commit media that the website or a maintained guide
uses, and reuse identical files that already exist. `npm run check:repo-hygiene`
checks this.

Some older test inputs were removed from the working tree. Checks that need them
read them from a fixed older Git revision through
`scripts/read-archived-fixture.mjs`, so clone the full history (no `--depth`).
The default scorecard command checks that historical baseline, not the current
release; pass a current external ledger to check new release records.
