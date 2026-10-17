# Parent-backed Native Source

The trusted Original/Parent producer supplies the actual task, graph, Worker,
lease, OFF, model/account/budget, journal and tool decisions. Source consumes
that producer through the existing `ControllerNativeTransport` and
`ControllerNativeToolTransport` interfaces. A public owner API grant, saved
Flow, serialized root or test fixture cannot provide this authority.

The server-owned producer module exports `nativeSourceParent`, typed as
`NativeSourceParent` from `controllerNativeClient.ts`. It contains:

- `transport`: the existing ownership/tool transport, including a private
  `bindingId`, protected Worker MCP configuration and actual one-use tickets.
- `requester`: the private loopback Source origin and bearer for the existing
  bounded `/v1/chat/completions` Worker requester.
- `codexProfile(context)`: a Parent-authorized attestation of the independently
  qualified private 0.157.1 binary and restrictive catalog. Both absolute paths
  and both SHA-256 digests are required. Ordinary 0.162.1 is a separate runtime.

`admit` authenticates a Worker against actual Parent records and returns an
opaque process-private context. `commit` holds the genuine Parent mutation and
revocation fence throughout the awaited Source callback. An expiring HTTP lock
or a Source-created claim record does not implement this contract. `observe`
propagates current revocation and closes its actual resources independently of
Source success. The producer must use one process-shared authority service
across Next server module graphs; it must not re-create its owner journals or
decisions per import.

Source retires a known Parent observer even when revocation arrives between
admission and observer setup. This prevents cancelled admissions from retaining
observers and exhausting the client admission limit. A failed observer close
remains an independent error alongside the original revocation.

At build time set `FLUJO_NATIVE_PARENT_MODULE` to the absolute existing trusted
producer module. The server build selects `configuredNativeSource.ts`, aliases
the producer into both app and proxy server graphs and invokes the production
`createNativeSourceComposition`. Client graphs do not receive the Parent module.
The generic `FLUJO_EXECUTION_ADAPTER_MODULE` selector is mutually exclusive.
Keep the Native selector when starting that build; selecting it without applying
the server hook fails rather than silently taking ordinary transport. Runtime
module paths, private headers and profile files must stay outside public DTOs
and source control. This selector is for a trusted source build, not a dynamic
plugin loader or an installed-package acceptance claim.

The consuming client wraps Parent contexts in fresh opaque handles, checks
current admission around asynchronous reads and tickets, pins configuration and
profile within a run, and retires observer resources on every exit. Source
independently rereads the binary/catalog and performs its existing restrictive
Native qualification before a credential-bearing launch. It does not treat the
attestation's version string or a JSON receipt as that qualification.

Inventory, the live nonce and built-in denial have separate 90-second phase
deadlines. A received live terminal ends that phase's timer; normal stdin EOF
then has the transport's bounded 45-second drain before forced stop and joined
closure. Actual owner cancellation still stops immediately. A delayed normal
exit must succeed with code zero; a nonzero or uncertain close cannot mint a
qualification. Qualification turns remain separate from business acceptance.

A Native Codex handoff ends the current owned turn. Queued SDK events after the
request must not cancel the enclosing run: only confirmed owned exit and pipe
closure permit the saved handoff to advance. Actual owner cancellation and tool
failures still abort that run and retain unresolved holds.

Ordinary Source builds retain their existing undefined configured adapter and
genuine Persona Original behavior. Focused deterministic tests cover consumption
and refusal only. Genuine production Parent admission, held-credential sending,
replay/restart/revocation reconciliation and the requested Worker/attached-child
journey require the actual producer. Full, remote, packed/installed and container
validation remains release pre-flight.

The Original model-step sender and Native attached-child scope use separate
private capabilities. Integrating them must preserve Original account routing,
single-request claims, historical read authority and the actual Persona fence.
An attached Native child keeps its own bound conversation and logical run while
sharing the Parent mutation fence; it cannot turn that scope into an Original
owner credential or a root admission. Asynchronous handoff decisions must finish
before Process advertises the permitted tools.

The current restricted Codex runtime forces ChatGPT login and transfers that
subscription authentication into its private home. A Parent profile attestation
does not change this backend, and an OpenRouter account cannot qualify it.
Integrations requiring OpenRouter inference need a compatible, independently
qualified provider path before invoking Native or claiming connected acceptance.

The October 14 consumer correction reproduced both the observer leak and lost
cleanup-error path before the repair. All 34 cases in the five affected
client/adapter/tool/build-selection suites, canonical typecheck, whole-source
lint and zero-warning changed-test/config lint passed afterward. These checks
exercise deterministic Parent controls; the genuine producer and connected
Worker/attached-child journey were still unfinished at that checkpoint.

The subsequent integration with main `0411a199` preserves Original account
routing, model-step issuance and sending, historical read authority, and the
Persona fence alongside Native child scopes. The Native host regression fixture
now saves its selected native model before dispatcher capture, matching the
catalog admission required by production Process execution. All 44 Native host
cases and 167 other affected cases passed; one Unix permission control was
skipped on Windows. The unchanged built Original path also passed a genuine
`openrouter/free` goal through its saved sender receipt, completion marker,
archive and Chat result, including restart durability. These results qualify
that integration and Original path; they do not supply Native producer or
connected Worker acceptance for that checkpoint. See the
[qualification receipt](evidence/native-source-main-integration-2026-10-14.json).

The October 17 integration preserves the current ordinary Codex endpoint and
compaction behavior alongside Native ownership, qualification and keyless tool
restrictions. Born-child admission now uses the shared identity capture's one
bounded startup warmup. Repeating that warmup in the app-server transport had
multiplied three exhausted OS birth probes into nine; exhaustion still closes
the child before registration or wire input. Native reader checks observe the
session only after the Original host accepts it, while session subscriptions
remain installed before completion events. Current validation and its explicit
acceptance limits are recorded in the
[October 17 receipt](evidence/native-source-main-integration-2026-10-17.json).

## Original owner producer

The server-owned producer is
`src/backend/services/originalOwner/configuredNativeParent.ts`. Select its
absolute path with `FLUJO_NATIVE_PARENT_MODULE` for the build and startup. Set
`FLUJO_NATIVE_CODEX_PROFILE` to a private JSON file containing the five exact
profile fields above, `FLUJO_NATIVE_SOURCE_ORIGIN` to the Source loopback origin,
and `FLUJO_NATIVE_TOOL_ORIGIN` to a separate loopback origin and port. The
listener starts only after genuine admission. Ordinary builds keep their
existing transport. A trusted launcher closes the Source composition when it
retires this integration; composition cleanup also closes the Parent, its
listener, observers and in-flight command effects.

The existing account/enrollment API admits `codex-cli` models only with the
selected, byte-checked 0.157.1 profile and the current file-backed ChatGPT
subscription identity. Native accounts contain no API key or provider routing
headers. Their saved models stay keyless and do not acquire the separate
Original model-sender credential binding. Only `gpt-6-luna` and `gpt-6-sol` are
eligible, with no fallback. Refresh within an identified account preserves its
scope; another account, changed model/profile, revoked approval, task/goal/OFF
change or lost lease refuses further effects. The CLI has no owner-enforced
hard output or per-inference budget seam: enrollment requires an explicit
`null` decision for both existing budget fields and rejects finite values
instead of ignoring them or changing the provider route.

The genuine dispatcher captures Native authority beside Original authority.
The Parent authenticates the enrolled Worker against that live capture and
durably consumes one admission before exposing a fresh opaque context.
`claim.runId` identifies the dispatcher/fleet run; `bindRun` receives the
independent Source logical run. A saved claim or a new lease cannot replay an
old admission. The dispatcher executes through this same Source composition,
preserving its immutable Core, Persona attribution, instruction context and App
grants. Exact genuine root capabilities and core-created causal wrappers share
the existing Persona fence; lookalike callbacks do not. An installed attached
child retains its separate Source conversation and logical run.

The Subflow node admits only the installed single attached child from a current
root. It persists one invocation and running lane before asking Source for a
fresh child context. The Parent verifies that actual lane, the immutable child
graph and Core-created causal capability. Child attribution follows its parent;
the top-level Persona instruction context and Core App abilities stay confined
to the root. Synthetic prep objects, extra lanes, detached children and session
reuse cannot turn this path into another grant.

Parent commits hold the genuine Persona fence, then the private owner-journal
writer, throughout the awaited Source mutation. Account revocation uses that
same journal fence. Observation aborts on the captured authority signal and
checks persisted authority independently of Source progress; failed initial
observation retires the admitted resources too. Observer closure is not
completion proof. Only the exact opaque Source context and its independently
observed terminal root state complete admission. Other bound outcomes stay
unknown and block a replacement; inference receipts remain owned by the Native
host's journal.

Every durable publication and child-launch boundary still rereads current
authority. A Worker host does not repeat its own complete Goal/lease check
through a second alias, and lineage coalesces broker/root gates only when they
are the same function object. Distinct gates retain the broker/root/broker
sequence so a lease revoked during an awaited root check is refused.
The trusted Parent can also assert its immutable plan and child list in one
current-authority operation. Source retains the original individual checks for
transports without this operation; it does not cache freshness across calls.

The private `seagulled-worker` configuration is supplied in memory and is not
added to the saved/public server catalog. At dispatch, the isolation guard
rereads that authoritative private configuration and resolves its headers
independently, then checks the connected client's process-private identity
fingerprint. A caller-supplied configuration cannot authorize a connection;
retired, rotated or substituted connections fail closed. Ordinary stored and
managed transports keep their existing isolation checks. Its authenticated loopback MCP
endpoint accepts only the four existing Worker operations. Each call requires
a durable one-use ticket bound to the current admission, tool and final
arguments. The endpoint spends it before an effect, returns an independently
checked private receipt, and never forwards that receipt into the model
transcript. Read/write/list effects retain both fences through their bounded
completion. Exact enrolled commands spawn under those fences; completion waits
outside them. Commands receive a minimal environment, bounded output and a
deadline; revocation and shutdown join actual process-tree termination.

Before a Native Codex launch, Source checks the sealed broker inventory against
its exact live execution context. The SDK receives advertised schemas and the
opaque broker capability; it does not receive the host MCP binding map. Foreign
bindings, a different context, revoked authority and cancelled ports refuse
admission before any business model input.

File operations reject traversal, links, hardlinks, nonregular files and
observed directory/file identity replacement. These portable Node path checks
are not an OS-enforced filesystem sandbox: an external process racing an
ancestor rename between the last identity check and a filesystem syscall is
outside that guarantee. Only exact owner-granted command text is executable.
Do not substitute this integration for isolation of hostile local processes.

Deterministic authority, HTTP tool and born-child controls remain separate from
connected subscription, installed-package and live UI qualification. Current
run evidence must state which actual provider and Source journey were exercised;
constructing the producer or closing its observer does not supply that evidence.

The October 17 producer qualification exercised a saved Goal on the rebuilt
Windows Source app with actual `gpt-6-luna` at medium reasoning through verified
Codex ChatGPT subscription authentication. The root and its separate attached
child each completed a Worker read with a durable Parent receipt. The child
returned the file marker and joined once; the Activity, Goal and Native admission
completed. All application epochs closed and protected user files were unchanged.
The measured journey took 843.100 seconds. See the
[producer qualification receipt](evidence/native-parent-producer-2026-10-17.json)
for the qualified tree, earlier negative controls and integration validation.
This result does not establish installed-package, deployed-image, live UI swarm
or longer unattended-work acceptance.
