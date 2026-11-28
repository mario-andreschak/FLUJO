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

## Effort

`agy models` lists one entry per effort level, for example
`gemini-3.1-pro-low` "Gemini 3.1 Pro (Low)" and `gemini-3.1-pro-high`
"Gemini 3.1 Pro (High)". FLUJO folds these into one model, `gemini-3.1-pro`,
with the levels listed for it. The model editor's **Effort** offers exactly
those levels, and FLUJO passes the choice as `--effort`. The CLI turns it into
the matching thinking setting and refuses any level it does not list. FLUJO
keeps no table of its own, so a CLI update that adds or removes levels needs
no FLUJO change. Leave **Effort** empty for the model's own default. The
`default` choice and names that already end in a level (such as
`gemini-3.1-pro-high`, from connections saved earlier) keep their level and
have no **Effort** setting. If the CLI refuses a choice, FLUJO says which
levels the model offers.

## Continuing the CLI conversation

Each conversation node keeps one private CLI home, and later turns reopen the
CLI's own conversation with `--conversation <id>`, sending only the new
messages. Whenever that is not possible, the turn sends the whole FLUJO
conversation again, as a new CLI conversation. There is no setting.

- The prompt is sent only after the CLI confirms it reopened the saved
  conversation. The CLI silently starts a new conversation when the id is
  unknown, so FLUJO checks first and otherwise replays the full conversation in
  the same turn.
- A changed system prompt, tool list, tool binding, model, effort or key, an
  edited or shortened history, a failed or stopped turn, or a handoff all start
  a fresh CLI conversation on the next turn. So does a node that passes only
  part of the conversation to the model.
- The CLI reports token counts for the whole reopened conversation. FLUJO
  subtracts the counts saved after the previous turn, so usage shows each turn
  once.
- One run uses a session home at a time. A second run of the same node at the
  same moment, or a home left locked by a crashed FLUJO, falls back to a one-off
  home with the full conversation; a lock whose process is gone heals by itself.
- The copied account sign-in file is removed from the session home after every
  run. Session homes idle for a day, and one-off homes left by a crash, are
  removed automatically. Workspace snapshots exclude all of them.

Why not one long-running CLI process fed over standard input? Measured on
Windows 10 with the official CLI 1.4.8 and the local stand-in model (median of
three rounds of six turns): starting the CLI costs about 1.4 seconds per turn,
both for a full replay and for a reopened conversation, while a running process
answered later turns in about 0.16 seconds. Within one FLUJO run there is
nothing to gain: the CLI already runs the whole tool loop in one process, and
steering has to interrupt a turn, which Google's standard-input mode does not
support (it expects the next message only after the current result), so
steering restarts the CLI with the whole conversation. Across turns, a reopened
conversation survives a FLUJO restart and leaves no idle process behind.

## Other Google integrations

FLUJO does not use Google's Antigravity Python SDK or the managed Antigravity
agent API. The SDK does not document sign-in with a Google account the way the
CLI does. The managed agent runs tools on Google's side, where FLUJO's tool
approvals and local tool bridge cannot reach, and is billed separately from a
CLI subscription. An API-key user who wants Gemini without the CLI uses the
**Gemini (Native)** connection.

## How it is checked

`__tests__/model/antigravityCliIntegration.test.ts` runs Google's official
`agy` with a made-up API key against a local stand-in model, so no Google
account is involved. It covers tool isolation and approvals, cancellation,
hostile settings files, a conversation over several turns with a FLUJO
restart after a crash in between (the model still answers from turn one, each
turn's usage is counted once, an edited earlier message starts over), and
effort: for every model the CLI's own refusal must name exactly the levels
FLUJO derived, and each level of one model must reach the model request. The
main `test` job runs it on Linux; the `antigravity-cli` job of `verify-full.yml`
runs it on macOS and Windows after installing `agy` with FLUJO's own installer.

Runtime and catalog checks do not prove model entitlement or quota for a real
account. Use Test model to verify the selected model and FLUJO tool path.
