# A risky background change rolls itself out by measured rules, never by a flag or a person

Persona history cleanup (#481) first waited for a person to run 1% and 50%
stages, then for a live off switch and environment variables. Instead it now
measures, switches itself on after a clean week, and goes back to measuring on
any anomaly (`referenced`, `invalid`, `error`, `volume`). Its stored state is
reserved, so the generic storage API cannot become a back-door switch.

Enforced by:
- `__tests__/security/storageReservedKeys.test.ts`
- `__tests__/enduringAgents/personaRuntimeRetentionSweep.test.ts`
- `__tests__/enduringAgents/personaRuntimeRetentionProcess.test.ts`
- `afterPersonaRuntimeRetentionSweep` in `src/backend/services/enduringAgents/personaRuntimeRetentionControl.ts`

Prose: other background changes need their own anomaly list; judge which
failures a program can see before choosing the rules.
