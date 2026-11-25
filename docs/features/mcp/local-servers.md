# Connect a local MCP server

Open **Connected Apps → Connect App** and choose a local command. Enter the executable, arguments, environment variables, and working directory required by the server. Use an absolute executable path if it is not on the FLUJO server process's PATH.

Check the command outside FLUJO using the same operating-system user and working directory. A stdio server must use stdout for MCP protocol messages; diagnostic logs belong on stderr. Missing Node/Python/uv, incorrect working directories, or human-readable stdout banners are common startup failures.

Save, connect, and inspect the available tools/resources/prompts. Test a harmless operation before adding tools to an agent. Keep secrets in the connection's credential/environment fields and use only the required filesystem roots.

Local shell and filesystem processes retain the user's operating-system permissions. Workspace roots organize permitted working locations but should not be treated as strong containment for arbitrary shell commands.

For a server launched locally but accessed over HTTP, follow [launch-and-connect](launch-and-connect.md). For Windows command issues, see [shell diagnostics](bash-shell-diagnostics.md).

## Python servers (for example FastMCP)

A [FastMCP](https://gofastmcp.com) server file such as `server.py` runs over stdio by default (`mcp.run()`). First check that it starts in a terminal:

```bash
uv run --with fastmcp python /absolute/path/to/server.py
```

Stop it once it waits for input; FLUJO starts it itself. Then, in **Connect App → I have connection details → On this computer** (or the **Configure & Test** tab):

- **MCP server root path**: the folder that holds `server.py`.
- Leave **Install command** and **Build command** empty.
- **Run command**: only the program, for example `uv`.
- **Arguments**: one row per word: `run`, `--with`, `fastmcp`, `python`, `/absolute/path/to/server.py`. Add more `--with` and package rows before `python` if the server needs other packages.
- Put API keys under **Environment Variables**, not in the command.

If the packages are already installed in a virtual environment, set **Run command** to that environment's Python (for example `/path/to/.venv/bin/python` or `C:\path\to\.venv\Scripts\python.exe`) and use the path to `server.py` as the only argument.

Click **3) Test run**. When it passes, save and try a tool from the server's card.

## When the Test run fails

Python and Node.js report a missing file and a missing package differently. FLUJO shows the server's own error in the console and, for these cases, a short hint above the form:

| What the console shows | What it means | Fix |
| --- | --- | --- |
| `python: can't open file '…/server.py': [Errno 2] No such file or directory` | Python started but the script path is wrong. | Correct the `server.py` path under **Arguments**. Prefer an absolute path to a file that exists. |
| `ModuleNotFoundError: No module named 'fastmcp'` | The script started but a package is missing from the Python that ran it. | Install the package into that Python environment (`pip install …`, `uv sync`, or another `--with` row), or set **Run command** to the environment's Python. |
| `python: No module named my_server` | `python -m` could not find the module. | Check the module name under **Arguments**, or install the package that provides it. |
| `Error: Cannot find module '/…/dist/index.js'` (`MODULE_NOT_FOUND`) | Node.js could not find the script file. This is a Node.js error; Python never prints it. | Check the file path under **Arguments** and the root path. If a build creates the file, click **2) Build server** first. |
| `Error: Cannot find module 'express'` or `Cannot find package 'express'` | A Node.js package is not installed. | Click **1) Install dependencies**, or run `npm install` in the server's folder. |
| `spawn … ENOENT` or "command not found" | The program in **Run command** could not be started, or the root path does not exist. | Put only the program in **Run command** and everything else under **Arguments**; use an absolute program path; check that **MCP server root path** is an existing folder. |
| Test run times out on the first `uv` or `uvx` start | The package is still downloading. | Wait for the longer first-run timeout, or run the command once in a terminal first. |
