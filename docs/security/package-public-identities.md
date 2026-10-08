# Package public identities and supplied credentials

The shared package schema rejects recognized `{{secret.NAME}}` placeholders in
package IDs and names; model IDs, names and display names; MCP names, origin
names and declaration names; flow IDs, names and reference lists; node IDs,
labels and known flow/model/server reference properties; edge IDs, endpoints
and handles; and planned execution IDs, names and flow references.

Validation runs before the installer reads supplied credentials or accesses
host services. Declared runtime prompt and content placeholders remain allowed
and resolve during installation. Literal credentials authored as public text
cannot be inferred by this placeholder validator.

Flow addressing and display names use the validated public manifest separately
from resolved content. New flow IDs retain the existing full SHA-256 algorithm;
recorded legacy IDs retain their ownership checks and reinstall/uninstall
addressing. Planned execution IDs use the original public execution name.
This admission change does not migrate or scrub existing ledgers.

Reference and entity maps use null prototypes. Model substitutions accept only
own mappings, and rename sanitation preserves own prototype-like keys. The
installer copies the ledger into a null-prototype map before adding a package.
Status, uninstall inspection and uninstall select only own ledger entries.
The content resolver uses `Object.fromEntries` to preserve an own `__proto__`
property as data. These protections apply to the package boundary.

The public identity schema tests exercise each protected field and allowed
runtime prompts. Installer tests exercise rejection before a throwing secret
getter or host IO, stable IDs across credential changes, own prototype-like
keys, ledger round-trips, and inherited-ledger refusal. Existing collision,
retained ownership and Persona execution protection tests remain in place.
These tests mock IO and do not establish installed-host or human acceptance.

This restores the public identity behavior underlying #678 and the fixture
typing corrections from #691 on the newer integration source. The historical
failure and correction are recorded in
[package-identity-fixture-types.md](./package-identity-fixture-types.md).
Fresh scanning determines any related CodeQL finding's disposition; no scanner
rule or compiler check is weakened by this change.
