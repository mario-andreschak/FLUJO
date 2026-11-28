# `runFlow.ts`, `ModelHandler.ts` and the MCP service `index.ts` only shrink: put new code in a module with one job and lower the ceiling in `scripts/execution-hotspots.json`

These three files grew with every feature (#571). Their line ceilings may only
go down; `npm run check:hotspots -- --write` lowers a ceiling after a file
shrinks. The map of which module owns what is in
`docs/architecture/execution-module-boundaries.md`.

Enforced by:
- `npm run check:hotspots`
- `scripts/check-hotspot-sizes.test.mjs`
