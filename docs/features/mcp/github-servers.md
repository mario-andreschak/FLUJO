# Connect an MCP server from GitHub

Open **Connected Apps → Connect App**, choose a GitHub repository, and follow its setup instructions. Review the repository owner, source, install/build commands, and requested credentials before installation. Package installation and build scripts execute code on the FLUJO host.

Prefer a maintained server with a documented MCP transport and pinned release. Confirm that its runtime exists on the machine running FLUJO. Configure the server's command, working directory, and environment variables; for HTTP servers, configure the endpoint and authentication method.

After installation, connect and inspect discovered capabilities. Test one harmless tool. If it fails, inspect the startup error and check runtime availability, installation output, working directory, and credentials rather than repeatedly reinstalling it.

Avoid storing secrets inside cloned files that might be committed. Keep user edits and data backed up before updating a server. See [local servers](local-servers.md), [launch-and-connect](launch-and-connect.md), and [workspaces](../workspaces.md) for execution and storage details.
