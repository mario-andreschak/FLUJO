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
The open editor reloads periodically and provides a reload action. A timed-out
or briefly failing `agy models` call is tried once more. If it still fails, the
last list loaded for the same CLI version and key (up to a day old) is shown
and marked as earlier. Sign-in failures are never hidden this way: they show
the sign-in steps. Without any earlier list, the editor shows recovery guidance
and preserves saved/custom model IDs; only the stable `default` choice remains
as an offline suggestion.

FLUJO checks installed version and required CLI flags before use. It accepts
1.x versions from 1.3.3 onward; incompatible executables fail visibly. This is
compatibility verification, not a checksum claim about a user-managed install.
Test model names the exact problem: no CLI could be installed, the CLI is too
old (run `agy update`), the CLI is a newer major version than this FLUJO
supports (update FLUJO), or it lacks the required flags. A slow first start
after an update gets one longer attempt before FLUJO reports a broken install.
A run that fails because the account is not signed in or the sign-in expired
shows the sign-in steps, also when the CLI reports it only in its result.
Automatic CLI updates remain disabled inside active private invocations to
avoid changing the executable during a run. All invocation isolation, native
tool denial, FLUJO MCP grants, cancellation and bounded output protections remain.
The private settings pin the default agent mode: newer CLIs start in Auto mode
where it is available, and Auto mode ignores the tool approval setting.
Authenticated restricted execution still excludes Antigravity.

## Continuing the CLI conversation (experimental)

By default each turn starts a new CLI process in a one-off private home and
sends the whole FLUJO conversation again. With **Settings → Experimental
features → Continue the Antigravity CLI conversation across turns**, FLUJO
keeps one private home per conversation node instead and reopens the CLI's own
conversation with `--conversation <id>`, sending only the new messages.

- The prompt is sent only after the CLI confirms it reopened the saved
  conversation. The CLI silently starts a new conversation when the id is
  unknown, so FLUJO checks first and otherwise replays the full conversation in
  the same turn.
- A changed system prompt, tool list, tool binding, model or key, an edited or
  shortened history, a failed or stopped turn, or a handoff all start a fresh
  CLI conversation on the next turn.
- The CLI reports token counts for the whole reopened conversation. FLUJO
  subtracts the counts saved after the previous turn, so usage shows each turn
  once.
- One run uses a session home at a time. A second run of the same node at the
  same moment, or a home left locked by a crashed FLUJO, falls back to a one-off
  home with the full conversation; a lock whose process is gone heals by itself.
- The copied account sign-in file is removed from the session home after every
  run. Session homes idle for a day, and one-off homes left by a crash, are
  removed automatically. Workspace snapshots exclude all of them.

Runtime and catalog checks do not prove model entitlement, quota or inference.
Use Test model to verify the selected model and FLUJO tool path. Full regression,
packaged-consumer and live acceptance checks remain release pre-flight gates.
