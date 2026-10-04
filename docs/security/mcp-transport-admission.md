# MCP transport admission

## Trigger and behavior

The beta factory previously treated every value other than its three remote branches as stdio. Runtime-home policy, stdio OAuth registration and later stdio-specific decisions require the explicit `stdio` tag. A malformed or absent live tag could therefore take different paths through policy and launch construction. The v1 stdio factory already rejected a non-stdio tag; the beta path did not.

All live connection/test inputs, explicit transport updates, persisted saves, both SDK transport factories and the runtime-home policy now admit only the exact `stdio`, `streamable`, `sse` and `websocket` values. Direct stdio launch resolution also requires `stdio`. Rejection uses the fixed `MCP_TRANSPORT_INVALID` diagnostic before reading command, environment, launch or header material, constructing a transport, decrypting headers, reusing a client or saving a record. Beta websocket remains explicitly unsupported.

For historical stored records only, an omitted transport is normalized in memory to an explicit `stdio`. This preserves the old intended default and makes its runtime-home policy run. Explicit null, false, zero, blank, differently cased, unknown or structured values are refused rather than coerced. An invalid stored record fails the load, and an invalid record fails the complete save before any write. Partial updates that omit transport retain the existing tag. Read-time normalization does not mutate or rewrite the stored input.

## Evidence

Owner checkout base: `d6ffb0b29ec7abaf3c8e57d85aa35bb36e29019b`, Next 16.3.8, Windows Node 22.13.1. The installed Next route guide was read before editing; no framework API or dependency was changed.

- 83 assertions passed in eight focused suites, including new storage, pure admission, actual v1/beta factory rejection and service-boundary regressions; existing beta protocol, runtime-home, disabled server and install-origin controls also passed.
- 23 assertions passed in four additional compatibility suites: reconnect/update, restart loop, remote-root normalization and masked-header Test Connection.
- The small admission helper and its pure tests passed a scoped TypeScript check with Next ambient declarations. All changed files passed ESLint and `git diff --check`.
- Factory tests import the installed SDK paths and reject before launch-material getters are read. They do not start a process or contact a remote server. The storage regression confirms legacy normalization activates its explicit isolated runtime-home setting.

## Limits and review boundaries

This fixes transport ambiguity; choosing a supported transport is not approval to use a privileged tool, endpoint, host path or credential. The stdio OAuth and HTTP OAuth branches still implement separate protocol behavior, and the assigned user-controlled-bypass CodeQL alerts need exact-source review and a fresh JavaScript scan. This receipt does not claim their closure.

The root-derived base has runtime-home preferences and the standalone isolation core, but does not contain the pending managed Docker integration from #615/#619. This patch therefore makes no claim that the managed-container grant policy or cleanup has been installed or qualified. That integration needs these admission guards preserved when combined.

The factories and MCP service source bytes change. Any source-bound factory/runtime qualification must be refreshed after integration; earlier frozen receipts remain evidence of their original heads. Full graph TypeScript, build, aggregate CI, installed artifacts, live providers, default MCP isolation, continuous revocation, human acceptance and the independent A- reassessment remain separate coordinator gates.
