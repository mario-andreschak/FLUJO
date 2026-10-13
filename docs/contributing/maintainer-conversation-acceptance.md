# Complete conversation metadata acceptance

This is the source contract for a separate successor of frozen #774 at
`b553bac2c1289e56a30e53469469caee7d606e79`. Preparing the correction does not prove
its tests or installed behavior. New execution requires a coordinator assignment.
Preserve the original #763 failed receipt, controller, raw archives and #774's own
native/CI evidence unchanged; none qualifies this successor.

## Observations and comparison

The previous comparator selected seven conversation fields. Its raw signed 3.46.2
GET response also contained `updatedAt`, `transcriptWindow`, `parentConversationId`
and `rootConversationId`; its archive additionally contained `trackingInfo` and
`source`. Those fields were not covered by the seven-field comparison.

The successor retains two independent full JSON observations in `original-state.json`:
`conversation` is the complete GET response and `conversationArchive` is the complete
stored record returned by a separate `chatHistory` backup request. The GET route
constructs a finite response and therefore cannot prove preservation of fields it
does not expose, such as stored `systemMessage` or execution tracking. The archive
observation covers those fields without deriving an expected record from the later
archive being verified. Raw HTTP responses and ZIP bytes also remain evidence.

Seed verification checks the prescribed identity, title, flow, two complete inert
messages, configuration, timestamps and durable creation metadata. Additional fields
in either observation are retained. Subsequent comparisons require every key and
value in each complete observation to match, including unknown fields, nested
timestamps, tracking data and array order. Adding or deleting a field fails.
Object-key order may vary. There is no ignored conversation field or volatile
timestamp exception. The complete flow inventory comparison and its two top-level
timestamp exclusions continue independently.

## Explicit cross-view rules

These rules validate coherence between observations. They do not remove or rewrite
fields before retaining or comparing either raw observation.

| Rule | Source basis and refusal behavior |
| --- | --- |
| Archive `conversationId` equals API `id` | The create route writes the requested ID; backup writes the whole stored record; GET exposes that ID as `id`. Conflicting optional aliases or missing canonical IDs fail. Optional matching aliases remain compared as observed fields. |
| API parent/root IDs equal archive values, defaulting absent or null archive values to null | GET uses `?? null` for these two fields. Non-null links must agree. Absent and explicit-null storage shapes can each qualify as a baseline, but changing raw presence after capture fails. |
| API `transcriptWindow` is the exact complete snapshot window | Unbounded GET calls recover the inert snapshot, preserve each message object and derive `truncated: false`, `loadedCount` and `totalCount` from the message length with `source: 'snapshot'`. Missing, extra or forged window keys, truncation or a durable-log source fail this bounded fixture profile. |
| API/archive messages and every shared property agree | This fixture uses explicit message IDs, no system-role messages, execution route, durable log or compact-tool query. No message transformation is allowed. Other properties present in both observations must agree exactly. |
| API/archive `updatedAt` agrees and stays preserved | Creation supplies the fixed nonzero timestamp. The title-only PATCH preserves `updatedAt`; backup and restore write the full record without changing it. Regenerated timestamps fail rather than being dropped. |

The source trace is identical at signed public artifact source
`320347356891aa1c24e0f2f9ce12719317e58bde` and frozen b553 for the create/GET routes,
backup, restore, storage collection writer and transcript resolver. Relevant paths:
`src/app/v1/chat/conversations/route.ts`,
`src/app/v1/chat/conversations/[conversationId]/route.ts`,
`src/app/api/backup/route.ts`, `src/app/api/restore/route.ts`,
`src/utils/storage/backend.ts`, and `src/backend/execution/flow/conversationLog.ts`.
The stored tracking execution ID and start time are generated once during creation;
they are captured independently and must remain exact afterwards. The seed's empty
node tracker is not permission to ignore that object or its unknown properties.

## Receipt and assigned controls

Synthetic-state schema 2 binds both observations' `original-state.json` bytes and
SHA-256, exact selections, verified provenance and the exact conversation comparison
profile, including an empty ignored-fields list. Rehashed old seven-field data,
schema 1 or a modified profile cannot satisfy this gate. Complete archive verification
compares the full stored record against the independently captured original. It
labels that scope separately from complete API readback comparison.

Assigned native controls must accept the actual absent-parent/root storage defaults,
explicit null defaults, matching aliases, complete derived window and object-key
reordering. They must reject changed, added or deleted unknown API/archive metadata,
`systemMessage`, tracking IDs/times/entries, top-level or nested timestamps, parent/root
links, forged windows, conflicting aliases, message changes and ownership-bearing
records. Retain exact source, selectors, runtime, TAP, failures and terminal handles.

An actual signed installed baseline/recovery run needs a fresh assignment and
fresh disposable output. Compare complete snapshots after rejected restores, valid
restore, re-export, upgrade before any restore and restart as applicable. Record
any compatibility difference as a failure. Do not repair historical evidence or
infer human adoption, maintainer consent or release qualification from these controls.
