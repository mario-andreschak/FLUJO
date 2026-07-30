# Standalone FLUJO MCP servers

This workspace contains the stdio MCP processes managed by FLUJO:

| Package | Executable | Purpose |
| --- | --- | --- |
| `@flujo-ai/mcp-flujo` | `flujo-mcp-flujo` | FLUJO application tools and run resources, delegated to the running backend through a private authenticated local bridge. |
| `@flujo-ai/mcp-filesystem` | `flujo-mcp-filesystem` | Confined filesystem tools, MCP Apps HTML resources, and the bounded touched-file resource registry. |
| `@flujo-ai/mcp-bash` | `flujo-mcp-bash` | Cross-platform foreground and background shell execution with process-tree cleanup. |

Each package builds to `dist/index.js`, uses `StdioServerTransport`, and reserves stdout for MCP protocol frames. Diagnostics are written to stderr. FLUJO launches the compiled entrypoints with Node and manages connection, restart, roots notifications, and shutdown through the same client lifecycle used for external MCP servers.

## Development

From the repository root:

```text
npm install
npm run build:mcp
npm run typecheck:mcp
npm test -- --runInBand __tests__/mcp/stdioServers.test.ts
```

A package can also be launched directly after building:

```text
node mcp-servers/filesystem/dist/index.js
node mcp-servers/bash/dist/index.js
```

`mcp-flujo` is independently executable, but application-state calls require `FLUJO_MCP_BRIDGE_ENDPOINT` and `FLUJO_MCP_BRIDGE_TOKEN`; FLUJO supplies both automatically. Do not persist or expose the bridge token.

## Roots and operator policy

The filesystem server reads MCP client roots and treats `FLUJO_FS_ROOTS` as an operator hard ceiling. The bash server uses `FLUJO_BASH_ROOTS`, falling back to `FLUJO_FS_ROOTS`. Client roots may narrow an environment ceiling but cannot widen it. When no ceiling or client roots exist, the standalone server falls back to `FLUJO_DATA_DIR`.

Relevant variables:

- `FLUJO_DATA_DIR`: base for relative paths and the no-roots fallback.
- `FLUJO_FS_ROOTS`: path-delimited filesystem ceiling; also the bash fallback ceiling.
- `FLUJO_BASH_ROOTS`: path-delimited bash working-directory ceiling.
- `FLUJO_ALLOW_PROTECTED_PATHS=1`: operator override disabling the optional protected-path deny layer.
- `FLUJO_PROTECTED_PATHS_ENABLED=1`: resolved by FLUJO from the application setting and supplied to filesystem/bash children.
- `FLUJO_BASH_INHERIT_ENV=1`: explicitly lets bash commands inherit the full FLUJO backend environment. Without it, commands receive only the existing minimal allow-list.
- `FLUJO_MCP_DEBUG=1`: enables package debug diagnostics on stderr.

Filesystem resource reads re-check confinement against current roots. The touched-file registry stores at most 200 descriptors and serves current file content with the existing response-size cap.

## Shutdown and troubleshooting

Closing the MCP client closes the stdio transport. Signal handlers close the server, and the bash package terminates active process trees using Windows `taskkill /T /F` or POSIX process-group `SIGTERM` with `SIGKILL` escalation.

If a built-in server cannot connect:

1. Run `npm run build:mcp` and confirm the package's `dist/index.js` exists.
2. Check the MCP server stderr log; protocol output must never be written to stdout.
3. Confirm configured roots fall within the operator ceiling.
4. For `mcp-flujo`, launch it through FLUJO so private bridge credentials are present.
