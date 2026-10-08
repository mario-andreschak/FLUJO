# Connect a local MCP server

Open **Connected Apps → Connect App** and choose a local command. Enter the executable, arguments, environment variables, and working directory required by the server. Use an absolute executable path if it is not on the FLUJO server process's PATH.

Check the command outside FLUJO using the same operating-system user and working directory. A stdio server must use stdout for MCP protocol messages; diagnostic logs belong on stderr. Missing Node/Python/uv, incorrect working directories, or human-readable stdout banners are common startup failures.

Save, connect, and inspect the available tools/resources/prompts. Test a harmless operation before adding tools to an agent. Keep secrets in the connection's credential/environment fields and use only the required filesystem roots.

Local shell and filesystem processes retain the user's operating-system permissions. Workspace roots organize permitted working locations but should not be treated as strong containment for arbitrary shell commands.

For a server launched locally but accessed over HTTP, follow [launch-and-connect](launch-and-connect.md). For Windows command issues, see [shell diagnostics](bash-shell-diagnostics.md).
