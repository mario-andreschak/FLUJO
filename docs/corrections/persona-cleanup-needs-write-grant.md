# Persona runtime cleanup writes only with a grant from the rollout switches

Enforced by:
- `PersonaRuntimeRetentionWriteGrant` argument of the compactors in `src/backend/services/enduringAgents/compactRuntime.ts`, checked by `npm run typecheck`

Verified by:
- `__tests__/enduringAgents/personaRuntimeRetentionSweep.test.ts` through `npm run test:enduring-agents` (the manual "verify-enduring-agents" workflow; pull request CI skips Enduring Agents)
