# Every file the execution and MCP architecture guide names exists, by its path or inside a folder the guide names

The guide is how a new maintainer finds which module owns a behaviour (#571).
Twice it pointed at files that were not where it said: on November 25, 2026
four rows were out of date after code moved, and the maintenance exercise of
#661 found names such as `init.ts` and `workspace.ts` that a reader could not
place. Write a file as its path from the repository root, or as its name inside
a folder the guide names in backticks, and update the guide in the same change
that moves or removes the file.

Enforced by:
- `npm run check:hotspots`
- `scripts/check-hotspot-sizes.test.mjs`
