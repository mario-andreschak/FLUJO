# A route handler's request parameter is required, never optional

`export async function GET(request?: Request)` passes the type check and the tests, but `npm run
build` refuses it, so the mistake only shows after a long build (the scripted pilot's build found
one in `src/app/api/workspaces/route.ts`, #577). Tests call the handler with `new Request(url)`.

Enforced by:
- `flujo/route-request-required`
- `tooling/eslint-plugin-flujo/rules.test.mjs`
