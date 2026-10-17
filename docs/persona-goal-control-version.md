# Versioned owner Goal controls

`POST /v1/personas/{personaId}/work-items/{goalId}/control` accepts the optional
`expectedUpdatedAt` alongside `action`. It is the exact nonnegative safe-integer
`updatedAt` read from the original owned root Goal. The existing owner/workspace,
encryption-unlock and strict-local boundary still applies. Successful responses
are no-store. Browser/model text grants no control authority.

The fence supports `pause`, `stop` and `retry` on ongoing Goals only. It rejects
ordinary Tasks and queue movement rather than implying those controls have the
same atomic guarantee. The service checks the version under its existing native
Persona runtime lock before persisting any new intent. Fenced callers skip the
legacy pre-control reconciliation, and matching versions with an original
pending control are held. A stale request returns 409 with
`PERSONA_GOAL_CONTROL_VERSION_CONFLICT`; a pending control returns 409 with
`PERSONA_GOAL_CONTROL_PENDING`. Neither changes the Goal or reconciles its prior
control. Unknown/foreign identity and invalid input retain existing 404/400
semantics. Native persistence, cancellation, scheduling and crash recovery remain
owned by the existing control engine.

Two controls with the same version can commit at most one new intent. After a
lost ACK the caller must retain its original attempt and read the original
Goal/runtime; it must not reread a newer version and retry automatically. A
control ACK is not execution, a completed business action, or verified remote
stop. Clients without the optional field retain existing behavior; safety-sensitive
integrations must always supply it and must never downgrade when an older strict
route rejects the field. An operator's later explicit action needs fresh authority,
current evidence and its own durable intent, not a hidden retry.

This contract enables safe reviewed continuation consumers, but activates no
Goal, model, provider, channel or product roster. A consumer must qualify effective
deployed source/model/account/tools, dependencies, consent, result return and
unknown actions before requesting `retry`. Calma currently uses the fence only
for an explicitly authorized assigned-staff pause.

Local typecheck/lint and the inspected non-container build are development gates.
Stale/current pending controls, concurrent retries, replay, unsupported scope,
strict input and HTTP guard regressions are retained for actual release preflight;
they are not operational acceptance evidence.
