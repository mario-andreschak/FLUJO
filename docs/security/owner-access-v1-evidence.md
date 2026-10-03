# Owner bearer foundation: source evidence

Date: October 3, 2026. Base source:
`3511ba49514fe8cf525f5a22c16c3806bf3886ba`.
Owned branch: `codex/scorecard-security-auth`.
This evidence belongs to the commit containing this document and its PR diff;
it is not installed-artifact acceptance or an independent security grade.

Environment: Windows x64, Node 22.13.1, npm 11.19.0; fresh owned
`npm ci --ignore-scripts --no-audit --no-fund` (1351 packages). Locked installed
Next 16.3.5, Zod 4.4.3, TypeScript 6.0.3, Jest 30.4.2.
No private runtime data, provider calls, production listener or controller was used.

## Executed checks

- New `ownerAccess.test.ts`: 36 assertions passed, one suite, including three
  fresh, serial OS subprocesses for valid/revoked/corrupt durable policy. The
  subprocess loads source through the checkout's TypeScript compiler; it is not
  a built/packed Next artifact or a full app restart.
- Existing `middlewareOriginGuard`, `workerIngress`, `routeGuardDrift`,
  `openAiGuardDrift`, `workspaceRouteWrapper` and `api/workspaceRoute`: 131 tests
  passed, six suites.
- Existing `workspace/mcpOauthCallbackIsolation`, `workspace/oauthStateIsolation`
  and `security/registryOauthAllowlist`: six tests passed, three suites.
- Scoped TypeScript check of the two new security modules passed.
- ESLint of both new modules, proxy, workspace wrapper, new test and child
  fixture passed with `--max-warnings=0`.
- `git diff --check` passed.

Each command ran serially with exit 0. The main runner initially exited 1 with
**zero collected tests** due to the managed Windows `.codex` path's generated
test glob. A temporary explicit-match config retained the normal Next/SWC setup
and node project and restored collection. Engineering owns the shared fix.
The first scoped tsc config omitted TypeScript 6's explicit Node types and exited
1; adding `types: ["node"]` to that temporary config made the same modules pass.
Neither failed attempt is acceptance evidence.

## Reproduce the scoped checks

Create the ignored `.tmp/owner-jest.config.mjs` in the owned checkout:

```js
import standard from '../jest.config.mjs';
import { fileURLToPath } from 'node:url';
const rootDir = fileURLToPath(new URL('../', import.meta.url));
const config = await standard();
export default { ...config, rootDir, projects: config.projects.map(project => ({
  ...project, rootDir,
  testMatch: ['**/__tests__/**/*.test.{ts,tsx}'],
  testPathIgnorePatterns: ['[/\\\\]node_modules[/\\\\]'],
})) };
```

Retained config SHA-256:
`3b4be15b023d68c8585e1e59df293f02944b089198a8e2624286696c111e1e1a`.
Only explicitly selected node suites were run with this discovery workaround.

```text
node scripts/run-local-jest.cjs --config .tmp/owner-jest.config.mjs --selectProjects node --runInBand __tests__/security/ownerAccess.test.ts
node scripts/run-local-jest.cjs --config .tmp/owner-jest.config.mjs --selectProjects node --runInBand __tests__/security/middlewareOriginGuard.test.ts __tests__/security/workerIngress.test.ts __tests__/security/routeGuardDrift.test.ts __tests__/security/openAiGuardDrift.test.ts __tests__/workspace/workspaceRouteWrapper.test.ts __tests__/api/workspaceRoute.test.ts
node scripts/run-local-jest.cjs --config .tmp/owner-jest.config.mjs --selectProjects node --runInBand __tests__/security/ownerAccess.test.ts __tests__/workspace/mcpOauthCallbackIsolation.test.ts __tests__/workspace/oauthStateIsolation.test.ts __tests__/security/registryOauthAllowlist.test.ts
```

The final standalone owner suite includes the added OS-process probe; the earlier
combined OAuth command ran the previous 35-case owner suite plus the six existing
OAuth tests. Counts above distinguish final new-test and existing-test evidence.

Create `.tmp/owner-tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "include": ["../src/backend/services/security/ownerCredentials.ts", "../src/backend/services/security/ownerAccess.ts"],
  "compilerOptions": { "incremental": false, "types": ["node"] }
}
```

SHA-256: `3bb95ea1880fc86378c6d473e362b6bd742bc8fb2e500fd958d146ef4b439195`.

```text
node node_modules/typescript/bin/tsc --noEmit -p .tmp/owner-tsconfig.json
node node_modules/eslint/bin/eslint.js src/backend/services/security/ownerCredentials.ts src/backend/services/security/ownerAccess.ts src/proxy.ts src/app/api/_workspace.ts __tests__/security/ownerAccess.test.ts __tests__/security/fixtures/owner-access-child.cjs --max-warnings=0
git diff --check
```

## Pending acceptance

Root/MCP typechecks, full lint/tests, Windows/Linux production builds and packed
app process checks need coordinator-scheduled or CI evidence. Browser pairing,
logout/CSRF, continuous established-stream revocation, per-tool/flow grants,
remaining handler/service coverage, unauthenticated network/public startup
refusal and consumer migration are still #566 work. #567 migration/private key
protection and #568 OS/container capability enforcement are not implemented by
this PR. Independent threat review and #564/external-assessor agreement remain
pending. GitHub private vulnerability reporting was observed disabled; a
maintainer must enable it and name a responder. No release, deployment, merge,
live admission, human enrollment or independent grade is claimed.
