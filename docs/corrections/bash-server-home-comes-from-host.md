# The bundled Bash server's home, profile, config, temp and tool-config locations come only from the host; a value saved on its server record never overrides or replaces them

Older versions saved a private `HOME` and `GH_CONFIG_DIR` on that record, which
pointed installed CLIs at another home. The rule used to live only in a code
comment.

Enforced by:
- `__tests__/mcp/hostTerminalEnvironment.test.ts`
- `hostTerminalEnvironment` in `src/backend/services/mcp/hostTerminalEnvironment.ts`
