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
Worker/attached-child journey remain unfinished.

The subsequent integration with main `0411a199` preserves Original account
routing, model-step issuance and sending, historical read authority, and the
Persona fence alongside Native child scopes. The Native host regression fixture
now saves its selected native model before dispatcher capture, matching the
catalog admission required by production Process execution. All 44 Native host
cases and 167 other affected cases passed; one Unix permission control was
skipped on Windows. The unchanged built Original path also passed a genuine
`openrouter/free` goal through its saved sender receipt, completion marker,
archive and Chat result, including restart durability. These results qualify
that integration and Original path; they do not supply the missing Native
producer or connected Worker acceptance. See the
[qualification receipt](evidence/native-source-main-integration-2026-10-14.json).
