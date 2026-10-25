# Subflow preparation and recovery retention

Child execution admission does not cover work performed before a child starts.
Previously, Subflow preparation could split an entire item source, resolve all
task templates concurrently, construct a history view for every task, and clone
the resulting durable invocation before reaching `runFlow` admission.

A 2-MiB history repeated across 1,000 small tasks represents roughly 2 GiB of
durable input. JavaScript can share primitive string backing storage across
clones; serialization does not preserve those aliases. That calculation is a
representation estimate, not a measured 2-GiB RSS increase. A short newline item
source can independently produce a very large number of lane objects.

## Preparation policy

The preparation gate applies before item splitting/JSON parsing, task expansion,
durable plan cloning, recovery-plan reconstruction and inline lane scheduling.
It rejects an entire excessive request instead of truncating its task queue.
The separate legacy dynamic-selector limit remains independent of these bounds.

| Resource | Limit |
| --- | ---: |
| One source string, estimated UTF-16 bytes | 8 MiB |
| Jobs in one prepared invocation | 4,096 |
| JSON/data nesting | 64 |
| JSON/data traversal work | 100,000 values |
| Aggregate resolved task text, estimated UTF-16 bytes | 16 MiB |
| Resolution workers | At most 4 |
| Requested execution workers | Integer from 1 through 16 |
| One preparation's conservative allocation reservation | 128 MiB |
| Concurrent preparation reservations, process | 256 MiB |
| One external template-read scratch reservation | 28 MiB |
| Text resource read by a preparation token | 200,000 characters; truncation is refused |

These are admission estimates and operational policy. They are not OS memory
reservations or measured application heap guarantees. Plans account for repeated
history representations, metadata, graph copies, JSON escaping/encoding and
temporary serialization. Resolution scratch allocations remain reserved until
all started siblings settle. The gate checks V8 headroom and RSS together with
outstanding Flow input reservations. Authenticated operations status exposes
numeric active/reserved/refusal observations without task text or identifiers.

Line/JSON preflight scans source without constructing a split array, parsed
object graph or decoded message copy. JSON preflight is an allocation/work
check, not a replacement parser; small malformed input keeps its existing
ordinary parsing behavior. Actual resolved data and the final plan are checked
again before publication. Template replacement checks expansion before joining
pieces. Requested worker counts beyond the declared limit fail explicitly.

`SUBFLOW_PREPARATION_TOO_LARGE` carries status 413 in Flow error details and
requests a smaller batch, shorter input or fewer workers.
`SUBFLOW_PREPARATION_MEMORY` carries status 503 and a retry hint. A parent that
already started streaming delivers these details in its error event.
They are distinct from entry-point Flow admission errors: preparation can fail
after the owning parent has already executed and produced provider history.

## Durable ownership

Preparation refusal retains the pending handoff and complete task input. It does
not manufacture a successful acknowledgement, publish a partial invocation,
change durable lane identities or start children. Restored and synthetic plans
receive count, depth and descriptor-work checks before result/worker allocations.
Scheduling retains existing lane-input references; it does not charge another
durable JSON representation of every already-owned history. Recovery charges
the shared-input clone it actually creates. Session follow-ups additionally
reserve media cloning and multimodal text joining before child admission.
Refused restored plans remain persisted for inspection or explicit recovery.

Existing-plan scheduling still persists parent lane updates through the storage
boundary. Its repeated whole-snapshot serialization is a separate allocation
question; metadata admission does not establish a bound for that writer.

Terminal-cache eviction additionally recognizes the real recovery schema:
manual-action requirements, interrupted execution and unresolved tool effects
remain protected under TTL, count and byte pressure. Historical owner IDs on a
resolved completed/capped/cancelled/failure record do not by themselves pin that
state forever. Resolving ownership still requires successful persistence before
the state becomes eligible for eviction.

Native `structuredClone` and VM snapshots can contain another realm's genuine
Object/Array prototypes. Payload accounting recognizes those data objects and
complete binary backing stores without invoking constructor/getter hooks.
Opaque runtime classes and proxies remain outside payload traversal.

## Qualification limits

This boundary addresses preparation allocation and eviction eligibility. It
does not establish a whole-runtime or 24-hour envelope. Existing upstream
resource metadata, whole KV/global catalogue reads, already-owned live history,
debugger snapshots, provider outputs, event-log
serialization and sequence registries require their own accounting and evidence.
Exact-source tests, negative controls, build results and fresh runtime profiles
must be recorded with delivery. No original fatal-cause proof is implied.
