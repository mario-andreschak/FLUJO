# Contributing to Flujo

This section provides guidelines for contributing to the Flujo project.

## Documentation Guidelines

- **[Documentation Guidelines](./documentation-guidelines.md)**: Guidelines for contributing to documentation

## Code Contribution Guidelines

Use TypeScript and the existing module boundaries. Keep API handlers responsible for request validation and workspace/auth gates; put reusable behavior in backend/frontend services. Add regression coverage for bugs at the boundary where they occur.

For pull requests, explain the observable before/after behavior, affected platforms, data-migration implications, and checks actually run. Do not commit local workspaces, credentials, generated runtime data, or unrelated changes. Issues should include install method, version/revision, OS, reproducible steps, and redacted errors.

## Development Setup

Install Node.js 22+, clone the repository, and run `npm ci`, then `npm run dev`. Use a disposable `FLUJO_DATA_DIR` for runtime experiments instead of your personal workspace data.

Before submitting, run `npm run typecheck`, `npm run lint:all`, and the relevant Jest suites through `node scripts/run-local-jest.cjs --runInBand <test paths>`. Changes involving standalone MCP packages also require `npm run build:mcp` and process-boundary validation. CI separates ordinary and isolated suites; inspect raw failures and quarantine notes rather than relying only on the overall badge.

Run `node scripts/generate-api-inventory.mjs` after adding/removing API routes, and keep the relevant guide and changelog current. See [documentation guidelines](documentation-guidelines.md).
