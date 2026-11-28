# The tool tester's browser check runs on every broad check, so it cannot rot unseen

`e2e/features/inspector.spec.mjs` sat outside every workflow. It drifted from the app (wording, controls, a first-run guide that hides once an app connects) and so missed a real bug: with the newer MCP SDK, an app whose tool pages loop showed a shortened tool list as if it were complete, with no warning (#572). It now runs on the production build in the `First-use journey` job of `verify-full.yml`, and tool discovery fails with a clear error instead of shortening the list.

Enforced by:
- `assertFirstUseJourneyJob` in `scripts/workflow-contract.mjs`
- `scripts/workflow-contract.test.mjs`
- `__tests__/mcp/toolDiscoveryModernSdk.test.ts`
- `rejectRepeatedToolCursors` in `src/backend/services/mcp/toolDiscovery.ts`
