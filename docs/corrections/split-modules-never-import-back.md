# A module split out of `runFlow.ts`, `ModelHandler.ts` or the MCP service `index.ts`, or used by one of them, never imports that file back

Not even lazily or for a type. Pass what the module needs in as a parameter
(for example a small object of functions), or move the shared part into its own
module. Older two-way imports are listed with a reason in
`scripts/execution-hotspots.json` and must be removed, never added to.

Enforced by:
- `__tests__/architecture/executionHotspots.test.ts`
- `npm run check:boundaries`
