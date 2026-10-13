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
version, initialize over real stdio, return every catalogue page within bounded
page/model counts, reject invalid parameters with the expected JSON-RPC error
frame, and parse the installed public SDK's start/resume execution options. The
SDK's `--experimental-json` spelling is checked even when it is a hidden CLI
alias. These probes request no thread, turn or tool execution.

An atomic receipt records the binary version and digest, installed SDK version,
app-server protocol contract and qualification contract. A receipt from an older
SDK or contract, including a legacy receipt, must pass these isolated probes
again before ordinary calls can select it. Failed requalification falls back to
the bundle and retries after one hour; it does not reinstall the same candidate
or replay inference. Daily release checks can still install a newer candidate.
Qualification checks protocol compatibility. Completed
model inference and MCP acceptance remain separate real-use checks.

The update runs separately from inference. Future calls use the qualified
executable; existing calls retain a lease on their original version until
their complete invocation closes. Model discovery and allowance refreshes use
the same ordinary executable selection and release their leases after their
owned child closes, including error and abort paths. A failed lookup, download
or protocol check
retains a compatible executable and emits a server warning, without replaying a
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

Ordinary subscription conversations use an owned local app-server over stdio.
Flow instructions travel in `developerInstructions`, separately from user input.
Message deltas update the existing transcript message, and FLUJO's loopback MCP
bridge retains tool approval, bounds and call/result recording. The separately
admitted Native Original and restricted routes retain their existing policies.

Full-history resume checks the account, effective CLI, installed SDK, protocol
contract, model, tier, instructions, tools, working directory and canonical
history. Persisted token totals let a restarted application count only the new
turn without requiring an uncompressed rollout. Cache and reasoning tokens are
subsets of input/output, not additional tokens. Protocol events also supply the
latest request's context limit; the SDK fallback retains optional rollout reads.

Steering uses the active turn ID and acknowledges the mailbox only after the
server accepts it. A received completion-race rejection returns the correction
to the inbox and invalidates session reuse. Cancellation interrupts the owned
turn and closes the child; text already displayed stays in the transcript.
Uncertain ordinary submissions fail without an automatic replacement turn.
`FLUJO_CODEX_APP_SERVER=0` selects the retained SDK route for an intentional
rollback; API-key, restricted and Native routes still use their admitted paths.

Ordinary flows expose filesystem and other operations through FLUJO's MCP
bridge. Current CodeModeOnly models use Codex's computational wrapper to call
those offered tools. Native shell, agent, browser and computer feature flags are
disabled at startup; unsupported operations and server requests are refused.
The effective tool policy participates in session compatibility.
Ordinary instructions also require code-mode scripts to emit the relevant
returned tool content after awaiting it, including when a long call yields and
resumes. This keeps the actual result available for the model's final response.

A Process node with `allowQuestion` enabled can receive typed native Codex
questions through its existing question executor and tool-approval policy.
Questions requiring secret-entry semantics are refused. MCP servers with
elicitation explicitly enabled continue to present their form schemas.
Current models can publish an asynchronous question instead of a blocking RPC.
FLUJO interrupts that exact turn and requires its matching terminal before
presenting the question. Only the actual answer and a fresh execution-authority
check permit continuation. An explicit decline ends without another provider
turn and invalidates session reuse so later input includes canonical history.
Stop, connection loss and missing terminal proof prohibit continuation.
Pending questions and forms belong to the current workspace and conversation.
A browser reload or reconnect restores prompts while the application is still
waiting. Invalid answers retain the prompt for correction; resolved, stopped or
obsolete requests reject later answers. An application restart discards pending
mailboxes and clears stale forms without replaying the submitted turn.

The ordinary lifecycle batch does not claim issue #1097 complete. Native fork,
advertised service-tier controls, native compaction integration and packaged
runtime acceptance retain their separate criteria.

Protocol reference: [Codex app-server models](https://learn.chatgpt.com/docs/app-server).
