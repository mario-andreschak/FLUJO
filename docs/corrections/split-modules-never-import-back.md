# A module split out of `runFlow.ts`, `ModelHandler.ts` or the MCP service `index.ts`, or used by one of them, never imports that file back

Not even lazily or for a type. Pass what the module needs in as a parameter
(for example a small object of functions, or `runFlow` itself), or move the
shared part into its own module. There are no exceptions: the check refuses a
`backImportDebt` list in `scripts/execution-hotspots.json`.

Enforced by:
- `__tests__/architecture/executionHotspots.test.ts`
- `npm run check:boundaries`
