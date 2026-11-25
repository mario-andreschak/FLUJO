# `docs/api-reference/routes.md` lists exactly the route files and methods

It is generated; never edit it by hand. After adding, moving or deleting a route,
or after a merge conflict in it, run `node scripts/generate-api-inventory.mjs`.

Enforced by:
- `scripts/generate-api-inventory.mjs` (`--check` in the typecheck job of CI; also in `npm run check:routes`)
