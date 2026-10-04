# Package public identities and supplied credentials

The package installer previously resolved every secret placeholder in a flow
before deriving its installed ID and recording its manifest-local ID in the
ledger. A declared `{{secret.API_KEY}}` in a flow ID therefore became a supplied
credential: the deterministic-ID function consumed it, and the ledger's flow
map stored it as a plaintext key. Model/flow/plan names could likewise become
credential-bearing public identity or summary fields.

The shared package schema now rejects recognized secret placeholders in package
IDs/names; model IDs/names/display names; MCP names, origin names and declaration
names; flow IDs/names and explicit reference lists; node IDs/labels and known
flow/model/server reference properties; edge IDs/endpoints/handles; and planned
execution IDs/names/flow references. This uses the existing placeholder syntax
and declaration validator. Validation runs before `input.secrets` access,
service preflights or mutation. Runtime prompt/content placeholders remain
supported and resolve through the existing supplied-secret path.

Flow addressing and displayed names derive separately from the validated public
manifest rather than its resolved content. Planned-execution addressing also
uses its original public name. Existing deterministic public IDs and display
renames remain compatible with reinstall/uninstall. This changes admission for
credential-bearing identities; it does not migrate or scrub existing ledgers.

The internal reference and entity maps use null prototypes. Model substitutions
accept only own mappings, and rename sanitation preserves own prototype-like
keys. The install ledger is copied into a null-prototype map before storing a
package entry. Status, uninstall inspection and uninstall select only own
ledger entries. The content resolver uses `Object.fromEntries`, preserving a
literal own `__proto__` property as data without invoking its setter. These
changes apply to the package boundary; they are not a claim about every map or
downstream content consumer in FLUJO.

## Source qualification

The implementation is based on root integration
`6390bc017f87724c3e71f2474b5166e886e68ce8`, with locked Next 16.3.8 and Windows
Node 22.13.1. A final focused run passed 154 assertions across seven suites
without skips. The actual shared validator checks 36 public-field denials and
allowed runtime prompts. Actual orchestration tests prove invalid identities
do not access a throwing supplied-secret getter or host services, changing a
legitimate credential preserves a 64-character public ID while updating runtime
content, and summary/ledger output excludes supplied values. A frozen long-ID
fixture retains `pkg-my-pkg-public-local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-41b92396`.
Tests also exercise `__proto__`, `constructor` and `toString` through model/flow
references, own renames, ledger JSON round-trips and status/inspection, plus
own content properties and denial of inherited uninstall entries. Existing
build/serialization, consent, Persona protection, install/uninstall and rename
suites pass. These service tests use mocked IO boundaries and do not install a
package on a running host.

A separate controlled source comparison transpiled the actual baseline
installer and schema from `6390bc01`, then the actual patched source. Registry,
storage and model/flow/MCP/scheduler IO were fixture stubs; shared validators,
public-ID calculation and orchestration were real source. The baseline accepted
the placeholder-bearing ID, accessed the synthetic secret once, saved one flow
with a credential-derived ID and left the plaintext synthetic value in the
in-memory ledger. The correction denied the same manifest with the fixed
identity message, zero secret accesses, zero saved flows and no credential in
the ledger. Output recorded booleans and counts, not supplied credential values.

Changed-file ESLint and diff checks pass. A scoped TypeScript check of the
schema and its 16 source dependencies passes. Full installer graph
type/build/CI remains with the integration coordinator.

The legacy long-flow-ID suffix still uses eight SHA-1 hex characters. It is
retained to preserve public addressing, and this correction does not establish
collision resistance or cryptographic protection. The source dataflow relevant
to CodeQL alert #111 is changed, but fresh scanning and independent review must
determine that finding's disposition. No scanner dismissal/rule weakening is
included. Literal credentials authored as public text cannot be inferred by a
placeholder validator; other content, logs and exports require their own
boundaries. Existing ledger remediation, installed-release acceptance, human
acceptance and independent Security reassessment remain open for epic #563.
