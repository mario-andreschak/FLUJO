# Antigravity CLI setup and catalog

FLUJO uses Google's official `agy` executable directly. An API-key connection
requires only a Gemini API key: FLUJO detects the CLI or runs Google's official
installer when it is missing. There is no separate `flujo-agy` installation,
package-owned executable, or pinned model catalog. On Windows FLUJO checks
`%LOCALAPPDATA%\agy\bin\agy.exe` before PATH, so a terminal restart is unnecessary.

For account mode, launch `agy` as the operating-system user running FLUJO and
complete Google's browser sign-in. Immediately after installing on Windows,
run `& "$env:LOCALAPPDATA\agy\bin\agy.exe"`. An API key skips account sign-in.
Keys stay on the backend and are passed only to the private CLI invocation.

The model editor and guided setup query `agy models` in the selected API-key or
account mode. These are the models exposed by the official CLI, not a separate
hand-maintained FLUJO list or the Gemini REST catalog. The native Gemini API
connection separately queries Google's `models.list` API with pagination.
Antigravity model availability can differ by authentication mode and CLI version.
Update the official CLI with `agy update` when Google adds CLI model support;
no FLUJO model-list edit is required. Catalog results are cached for five minutes
per workspace, CLI version, authentication mode and private credential identity.
The open editor reloads periodically and provides a reload action. Failed
catalog requests show recovery guidance and preserve saved/custom model IDs;
only the stable `default` choice remains as an offline suggestion.

FLUJO checks installed version and required CLI flags before use. It accepts
1.x versions from 1.3.3 onward; incompatible executables fail visibly. This is
compatibility verification, not a checksum claim about a user-managed install.
Automatic CLI updates remain disabled inside active private invocations to
avoid changing the executable during a run. All invocation isolation, native
tool denial, FLUJO MCP grants, cancellation and bounded output protections remain.
Authenticated restricted execution still excludes Antigravity.

Runtime and catalog checks do not prove model entitlement, quota or inference.
Use Test model to verify the selected model and FLUJO tool path. Full regression,
packaged-consumer and live acceptance checks remain release pre-flight gates.
