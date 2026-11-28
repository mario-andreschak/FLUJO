# Persona history cleanup writes only with a grant from the rollout state

The only writer is the hourly sweep. Its grant re-reads the stored cleanup
state and the Persona lock before every write, so an anomaly found anywhere
stops the next write.

Enforced by:
- `PersonaRuntimeRetentionWriteGrant` argument of `executeRetentionPlan` in `src/backend/services/enduringAgents/retention.ts`, checked by `npm run typecheck`
- `__tests__/enduringAgents/personaRuntimeRetention.test.ts`
- `__tests__/enduringAgents/personaRuntimeRetentionSweep.test.ts`
