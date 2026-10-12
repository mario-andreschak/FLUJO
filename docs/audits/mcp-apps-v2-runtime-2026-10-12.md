# MCP Apps 2 runtime qualification

Existing [PR #1104](https://github.com/mario-andreschak/FLUJO/pull/1104)
upgrades ext-apps 1.7.5 to 2.0.3. The original candidate's SDK1 client type
failure was reproduced locally. The host bridge now uses split SDK2 client/core
types and its two-argument request options. Server and owner binding,
app-visible tool checks and live consent revocation remain enforced by the
existing backend. Cancellation reaches the tool adapter and browser resource
fetch. The backend retains its SDK1 integration over the unchanged wire protocol.

The [original failed test job](https://github.com/mario-andreschak/FLUJO/actions/runs/38178629088/job/114586263314)
also exposed SDK2's ESM browser PKCE dependency and jsdom's missing
TransformStream. Both reproduced locally. Jest now transforms that dependency
and supplies Node's platform stream implementation, preserving the existing
chat assertions.

## Qualified inputs and local checks

- Parents: existing PR `bb1c3009358b58eeb836569b23e0eda649b1935e` and main
  `78ac0d2dc88c8fa33313ee1fc88cfca5c3dfc43d`.
- Application-build source tree: `947a3806ab4e4403366e2ac149eb48a5de6ff862`.
  Runtime code, dependencies and build configuration remained unchanged after
  this build. Subsequent changes were the Jest configuration/setup and this
  record; the changed TypeScript test setup was checked again.
- Final qualified source tree before this record:
  `1ed44fd98be1a36cc4466edfe2a4c08bf191c57c`.
- 85 assertions passed across the frame compliance, owner handshake, app tool
  route, MCP Apps and chat markdown-link suites. The previously failed chat
  suite ran its three assertions successfully.
- Five real-package wire cases passed using the production client shim with
  actual App and AppBridge: tool/resource forwarding, JSON result
  notifications, tool/resource cancellation, retry and access revocation.
  Run with `node --experimental-strip-types --test scripts/mcp-apps-client.test.mjs`.
- Application typecheck, MCP workspace typecheck and lint passed. The final
  application typecheck after changing test setup passed in 15.475 seconds.
- The inspected non-container `npm run build` passed in 362.401 seconds.
  These are measured individual command durations; some work overlapped.

## Production application acceptance

A disposable loopback profile completed normal private-passphrase
initialization and authentication. Only filesystem was enabled. The existing
`file_browser_ui` tool launched its actual bundled App, whose own `list_dir`
and `read_file` requests read a real test directory/file through FLUJO.

All nine recorded steps passed: server selection and four journey steps at
1280×800 and 360×800. Each viewport verified launch/initialization, exact file
preview, a real root-confinement denial followed by refresh and preview
recovery, fullscreen with preserved preview, and close. Both had zero page
errors and zero document-width overflow. The owned application exited
gracefully, including observed pipe closure, without forced termination.

This qualifies the existing Apps host upgrade, rather than the broader
first-user/provider matrix. No full suite, online CI, container build or release
workflow was dispatched. Server-side cancellation of a resource RPC is an
inherited limitation; this change forwards the signal to the browser fetch and
the backend adapter boundary.

Upstream API changes are documented in the
[MCP Apps migration guide](https://apps.extensions.modelcontextprotocol.io/api/documents/migrate-to-v2.html).
