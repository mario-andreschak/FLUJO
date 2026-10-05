# Package flow identity and legacy references

`src/backend/services/packages/packageFlowIdentity.ts` owns deterministic flow
identity and ledger claim validation. `installPackage.ts` owns orchestration,
reference remapping, persistence and effect ordering. The helper has no storage,
Flow service, scheduler or MCP dependencies.

New flow IDs are the complete lowercase SHA-256 hex digest of the JSON tuple
`[packageName, manifestLocalFlowId]`: 64 filename-safe characters, with no digest
truncation, slug normalization or delimiter ambiguity. Lowercase encoding avoids
case aliases on Windows. Package version and requested display-name renames do
not change this identity. Planned-execution IDs retain their existing format.

The previous long-ID format retained only eight hex digits. A bounded source
control on the frozen implementation found that `flow-00045416` and
`flow-00139699`, under `collision-probe-` followed by 80 `x` characters, both
produce `pkg-collision-probe-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-5d8bc397`.
The original install loop saves both flows under that ID, overwrites the first,
and records the same installed ID for both local identities. Its remapped
subflow and schedule references consequently alias the surviving flow. Ordinary
slug normalization can also merge distinct short inputs.

## Existing installations

The install ledger's `entities.flows` mapping is the compatibility contract.
An unambiguous recorded `(packageName, localId) -> installedId` keeps its exact
ID, including a legacy short ID or eight-digit suffix. Reinstall therefore
preserves existing conversation, external subflow and schedule references;
it does not rename files or infer replacements for persisted references.
Display-name collision checks use that recorded ownership too.

Before installing any server, model, flow or schedule, installation rejects
duplicate local IDs, invalid recorded IDs, conflicting ledger claims and an
occupied new ID without recorded ownership. Identity occupancy and claims use
case-insensitive comparison so an installation is safe to move between Linux
and Windows. An unreadable ownership snapshot stops installation. A legacy
slug, folder or matching deterministic guess is not sufficient ownership.

Creation ownership for package-created flows survives reinstall, so a later
uninstall can still remove those flows. Explicit adopted provenance remains
adopted. Legacy ledgers without creation provenance keep their existing
flow-deletion semantics.

When several package/local identities already claim one legacy ID, the code
cannot determine which lost definition or external reference was intended.
Install and uninstall stop before entity mutations and retain the ledger for
explicit reconciliation. They do not silently migrate or delete that shared ID.

## Verification scope

Focused package identity, install, uninstall, Persona boundary and rename tests
exercise the real helper/orchestrator with controlled service and storage
edges. They cover the concrete collision, remapping, legacy reinstall, retained
creation ownership and mutation refusal. This source evidence does not establish
installed artifact behavior, SDK/process lifecycle acceptance, performance or
independent maintenance acceptance for #571/#661.
