# A module split out of `runFlow.ts`, `ModelHandler.ts` or the MCP service `index.ts` is listed in `scripts/execution-hotspots.json` and named in the architecture guide

A split helps the next person only if they can find which module owns a
behaviour (#571). Add the new module to the `modules` list of its big file in
`scripts/execution-hotspots.json`, which also stops it from importing that file
back, and add a row to the module map in
`docs/architecture/execution-module-boundaries.md`: what it owns and the
contract it keeps. Its first line says its one job in one sentence.

Enforced by:
- `npm run check:hotspots`
- `scripts/check-hotspot-sizes.test.mjs`
