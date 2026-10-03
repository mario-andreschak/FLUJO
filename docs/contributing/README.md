# Contributing to Flujo

You can run the focused checks below without a model account, private files,
an existing FLUJO installation, or paid tool calls. Node.js **22 or newer**, npm
and Git are required. Start from a fresh clone; preserve any existing checkout.

## Reproducible setup

```sh
git clone https://github.com/mario-andreschak/FLUJO.git flujo-contribution
cd flujo-contribution
git switch -c contrib/my-change
node --version
npm --version
npm ci --include=dev
npm run test:dependencies
node --test scripts/release-verification.test.mjs scripts/require-release-verification.test.mjs
```

`npm ci` must finish successfully in this checkout. The test wrapper rejects
missing/mismatched local dependencies rather than borrowing a parent's install.
If installation fails, retain the error and Node/npm/OS versions; do not copy
another checkout's `node_modules` or remove the lockfile to hide the failure.

To explore the UI, create a new empty data directory and choose an unused port.
PowerShell:

```powershell
$contributorData = Join-Path $env:TEMP ('flujo-contributor-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $contributorData | Out-Null
$env:FLUJO_DATA_DIR = $contributorData
$env:FLUJO_EXPOSURE_MODE = 'localhost'
node scripts/launch-next.mjs dev --webpack --hostname 127.0.0.1 --port 4300
```

POSIX shell:

```sh
export FLUJO_DATA_DIR="$(mktemp -d -t flujo-contributor.XXXXXX)"
export FLUJO_EXPOSURE_MODE=localhost
node scripts/launch-next.mjs dev --webpack --hostname 127.0.0.1 --port 4300
```

Open `http://127.0.0.1:4300`, keep the terminal running, and stop with Ctrl+C.
These commands select both local request policy and a loopback listener, even
when the shell inherited a network/public exposure setting. Use a fresh terminal
afterward so the disposable data and exposure variables do not affect your
regular installation. Do not import a personal backup or log into a provider
for the offline first PR. UI/model/MCP journeys have separate acceptance gates.
See [getting started](../getting-started/README.md) when you deliberately choose
to connect a provider or external tool.

Read this checkout's `AGENTS.md` and the relevant installed guide under
`node_modules/next/dist/docs/` before changing Next.js routes or components.

## A useful first PR

1. Select an unclaimed item from the [starter backlog](starter-backlog.md), check
   linked issues/open PRs, and agree scope in the issue before touching a shared area.
2. Find the responsible module and focused test recipe in the [task map](task-map.md).
3. Reproduce the behavior, make one small change, and test the observable boundary.
4. Explain the before/after result, revision, commands, failures and skips in the PR.
   Include screenshots for visible UI changes using synthetic data.
5. Request a human review. Revise from that review and retain its link. A bot PR or
   an unreviewed draft is useful work but does not count as independent human continuity.

Record setup friction and help received in the [onboarding evidence form](maintainership.md#evidence-record).
A contributor completing this guide without live coaching is a separate human
observation; automated checks cannot establish that outcome.

## Documentation Guidelines

- **[Documentation Guidelines](./documentation-guidelines.md)**: Guidelines for contributing to documentation

## Code Contribution Guidelines

Use TypeScript and the existing module boundaries. Keep API handlers responsible for request validation and workspace/auth gates; put reusable behavior in backend/frontend services. Add regression coverage for bugs at the boundary where they occur.

For pull requests, explain the observable before/after behavior, affected platforms, data-migration implications, and checks actually run. Do not commit local workspaces, credentials, generated runtime data, or unrelated changes. Issues should include install method, version/revision, OS, reproducible steps, and redacted errors.

## Development Setup

Use the clean-clone recipe above and a disposable `FLUJO_DATA_DIR` for experiments.

Before submitting, run `npm run typecheck`, `npm run lint:all`, and the relevant Jest suites through `node scripts/run-local-jest.cjs --runInBand <test paths>`. Changes involving standalone MCP packages also require `npm run build:mcp` and process-boundary validation. CI separates ordinary and isolated suites; inspect raw failures and quarantine notes rather than relying only on the overall badge.

Run `node scripts/generate-api-inventory.mjs` after adding/removing API routes, and keep the relevant guide and changelog current. See [documentation guidelines](documentation-guidelines.md).

## Review and escalation

Keep PRs focused and say which checks were actually completed. Do not weaken an
assertion, quarantine a new failure, or regenerate expected output solely to make
a check green. Retain skipped/manual/installed-release work as visible gaps.

Execution, credentials, authentication, MCP privileges, install/update, migrations
and release changes need a human reviewer familiar with the boundary and an
explicit compatibility/rollback assessment. The author must not self-certify
independent review. If no qualified reviewer is available, leave the PR pending
and record the missing backup. Repository enforcement is owned by #565; this
policy alone does not prove branch protection is enabled.

Raise non-sensitive decisions in the linked issue with evidence, alternatives and
affected consumers. Integration owners settle cross-stream compatibility. Escalate
unresolved release/security decisions to the consenting accountable human in the
[role register](maintainership.md), or mark that duty unstaffed. Do not invent an
approver or contact prospective contributors without authorization.
