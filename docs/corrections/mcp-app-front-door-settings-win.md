# MCP App settings set where FLUJO starts win over Localhost mode's local default for requests through a front door; this computer keeps `<app>.localhost`, a Settings-page Localhost choice ignores leftovers, and a wrong value falls back with one startup line

The startup line goes to the server's output: the app logger prints only errors, so a line sent through it never reached a real deployment's log (#1336).

Enforced by:
- `__tests__/mcp/sandboxLocalhostFrontDoor.test.ts`
- `scripts/front-door/front-door.test.mjs`
- `assertFirstUseJourneyJob` in `scripts/workflow-contract.mjs`

Verified by:
- `npm run journey:front-door` on a throwaway production build behind a local signed-in HTTPS front door (`scripts/front-door/run.mjs`)
