# FLUJO's standalone Skill catalog never asks the bundled FLUJO app, which serves it

The bundled FLUJO app answers `skills/list` by calling `/api/mcp/flujo/skills`. That route listed the
Skills of every app, the FLUJO app included, so it called itself through the app forever: a chat with
the built-in FLUJO agent opened thousands of connections in seconds until the computer ran out of
network ports. The app is recognised by its package, not by its name.

Enforced by:
- `servesStandaloneSkillCatalog` in `src/backend/services/mcp/standaloneSkills.ts`
- `__tests__/mcp/flujoSkillsCatalogRoute.test.ts`

Verified by:
- `npm run journey:feature-steps` (the "Run the built-in agent" step file chats with the FLUJO agent)
