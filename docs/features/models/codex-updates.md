# Codex models and runtime updates

The Codex model picker and connection wizard discover the catalogue through the
same workspace's file-backed ChatGPT login and ordinary Codex executable used
for inference. They call the public app-server `model/list` protocol, including
all pages, and use its reasoning options. There is no FLUJO-maintained list of
Codex model names. Discovery creates no thread, inference turn or tool call.

The catalogue is cached for one minute per workspace, login revision and CLI
executable. The editor refreshes while open. Account changes invalidate the
cache. An unavailable catalogue preserves saved and manually entered model IDs;
the connection wizard refuses to manufacture a stale model bundle. A listed
model is a catalogue entry, not proof of account entitlement. The runtime's
successful inference is the access check.

Ordinary Codex use checks the official npm registry for a newer stable release
once a day. It installs the exact released CLI package into a separate private
workspace directory, with lifecycle scripts disabled and no inherited provider,
npm or account credentials. The installed binary must report the expected
version, initialize over real stdio, return a model catalogue and retain the SDK's
execution flags before an atomic version/digest receipt activates it. These are
protocol checks, not a live inference or MCP acceptance test for every release.

The update runs separately from inference. Future calls use the qualified
executable; existing SDK calls retain a lease on their original version until
their complete invocation closes. A failed lookup, download or protocol check
retains the previous executable and emits a server warning, without replaying a
request. Failed checks retry on use after one hour. No app restart or rebuilt container
is needed for these ordinary CLI updates.

Public binary packages and receipts live under the workspace's
`db/codex-cli`, separately from its `db/codex-runtime` authentication and sessions.
Installation caches and failed candidates are removed. Retirement retains the
current release, its previous working release and every version leased by a live
process. Uncertain lease ownership prevents retirement. Set
`FLUJO_CODEX_AUTO_UPDATE=0` to retain the bundled executable in an intentionally
pinned installation. Verified private execution extensions, Native Original
hosts and Native tool-port integrations retain their separately admitted binary
policy and do not opt into ordinary runtime updates.

FLUJO also keeps its bundled SDK exact-pinned. Dependabot checks npm dependencies
daily; Codex-only version PRs enable auto-merge through the repository's ordinary
required verification gates. This keeps the SDK wrapper moving independently of
manual model-name edits. Application releases and deployments still follow the
normal release gates; an older deployed image must first receive this change.

The optional experimental host catalogue snapshot checks compatibility against
the selected executable's actual version instead of a hardcoded CLI generation.
It remains an explicitly enabled, per-invocation immutable override.

Protocol reference: [Codex app-server models](https://learn.chatgpt.com/docs/app-server).
