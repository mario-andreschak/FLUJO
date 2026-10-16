# Owner admission of a paused Goal

`GET/PUT /v1/personas/{personaId}/goal-admissions/{admissionKey}` is an owner,
workspace, encryption-unlock and strict-loopback administrative boundary.
`admissionKey` is exactly 64 lowercase hexadecimal characters. No Activity
identity, model, Flow, provider, tool, arbitrary WorkItem ID or activation state
can be supplied through this route.

PUT accepts exactly `title`, `description`, `successCriteria`. The actual native
`createPersonaWorkItem` and schema/store persist the root with `state: paused`,
zero rounds and no `nextRunAt` in its initial save. There is no interval where
this admission is saved active. Ordinary native Goal creation retains its
existing behavior. The new internal staging option rejects Activity authority
and non-root work. The notification uses the existing scheduler, whose paused
Goal gate remains in force; this path performs no dispatch or provider call.

The native stable-ID engine binds workspace, Persona and caller key. The
canonical request digest additionally binds the exact normalized intent.
Concurrent same-intent calls and lost-save acknowledgements read the same
native record; a different intent with the same key is a conflict. The reader
also verifies current saved intent against that digest, so later metadata drift
cannot masquerade as the original registration. GET is lookup only. Owner
runtime locks and the existing busy-Activity fence apply to reads and writes.

The versioned `flujo-goal-admission/v1` response contains explicit namespace,
caller key and a bounded Goal projection: ID, correlation description, request
digest, state, rounds and native version. It is private/no-store. Bounded body,
schema, domain and generic unavailable responses do not expose private errors.
This response is a registration observation, not execution, 100 participants,
remote stop, business completion or an action receipt.

This API does not supply a deployment/model attestation or a terminal result
port. Activation is a separate owner operation, requiring the consuming
product's reviewed source, approved model/provider, tools, policy, consent,
lineage and result/control bindings. It must not launch legacy saved rosters.
Do not infer any provider authorization from a paused Goal. Native deletion
is not a replay tombstone: callers must retain their own durable original
intent/attempt/receipt journal and refuse recreation after unknown effects or
mapping loss. Calma's adapter uses at most one PUT and independent GET readback.

Local lint/typecheck and the inspected non-container build cover development.
Synthetic storage/concurrency/scheduler and HTTP-boundary regression sources
are retained for release preflight; no live admission or provider acceptance
is claimed by source or fixture evidence.
