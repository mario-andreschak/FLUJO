# Antigravity runtime and model discovery

FLUJO bundles Antigravity CLI 1.3.3 and verifies its package-owned executable
against the pinned SHA-512 receipt before using it. A globally installed `agy`
does not replace this runtime. Native automatic updates remain disabled. If the
runtime is missing or changed, run `npm rebuild @flujo-ai/antigravity-cli` in the
FLUJO installation and restart it. The model connection diagnostic reports the
configured version, installed state, verification state and actual version.

The model editor discovers models using the selected connection's API key or
account login. Leave the key empty for account mode; an unresolved key is an
error. Google sign-in must belong to the FLUJO server or worker OS user. Account
cache contents, API keys and executable paths are absent from catalog responses.

`flujo-agy models --output-format json` returns:

```json
{"models":[{"id":"gemini-3.8-flash-medium","name":"Gemini 3.8 Flash (Medium)"}],"entitlementVerified":false}
```

This is FLUJO's validated JSON projection of the native `models` table: native
1.3.3 rejects the JSON flag. Listing a model does not prove subscription access,
available quota or API-key entitlement. Use the connection's Test action to
verify model and FLUJO tool access. Custom technical names remain editable.
Discovery does not enable unverified generation or effort controls.

Catalog commands use their own private invocation and never enter the active
conversation stream. Cached catalogs are separated by verified runtime version,
auth mode and a process-private credential fingerprint. Keyring-only account
mode is queried again because its identity changes cannot be observed safely.

Stop interrupts pending approval or local executor waits and passes an abort
signal to cooperating local executors. A late result cannot append a successful
tool message. Missing or incomplete native usage is unknown; FLUJO omits the
normalized total and retains reported counters separately in
`flujo_antigravity_usage`. An explicitly reported zero remains a valid total.

Authenticated restricted execution still excludes Antigravity. Persistent
session reuse is outside this maintenance batch. See the
[qualification record](../../audits/antigravity-native-1094-2026-10-12.md) for
the exact validation scope and outstanding release criteria.
