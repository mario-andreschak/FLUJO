# Tool result size limit

Some tools answer with a lot of text: a long log, a big web page, a whole
file. Sending all of it to the model costs money, slows the run and can fill
the model's memory for the conversation (its *context window*). FLUJO can
store such a result as a **run resource** instead. The model then sees the
beginning and the end of the result, plus a link (`flujo://run/...`). It reads
the rest with the `read_resource` tool, in parts if needed (`max_chars` and
`start_char`).

## Where to find it

**Settings → Advanced → Context management → Move large tool
results to a resource.**

| Control | What it does |
|---|---|
| Move large tool results to a resource | On: results over the limit are moved. Off (the default): results stay in the conversation, except the safety case below. |
| Automatic (based on the model) | The default size. A result may use an eighth of the model's context window. That is about 98 KB for a 200,000-token model, 500,000 bytes for a 1-million-token model, never less than 16 KB. |
| Custom size | Your own limit in whole kilobytes, from 1 to 102,400 (100 MB). |
| Line limit | Results with more lines are moved too. 0 means no line limit. Default: 10,000. |

The switch and the size choice save at once. The two numbers save with **Save
limits**. The next tool call uses the new setting; runs already waiting for a
tool are not changed.

## An agent's own limit

Each AI step of an agent can set its own limit, which wins over the
workspace setting for that step. In the agent editor, switch on **Expert
view**, select the AI step and choose **Full settings** → tab **Input /
output** → **Tool result size limit**:

| Choice | What it does |
|---|---|
| Use the workspace setting (Settings → Advanced) | The default. The step follows Settings → Advanced. |
| Automatic (based on the model) | An eighth of the step model's context window, even when the workspace switch is off. |
| Custom size | **Size limit for this step (KB)**, whole kilobytes from 1 to 102,400. "Save changes" stays off until the number is valid. |
| Keep results in full | Results stay in the conversation, even when the workspace limit is on. The safety net below still applies. |

The choice is saved with the agent (the step's `toolResultLimit`), so it
travels with copies, packages and exports. The line limit always comes from
Settings → Advanced. In an agent description (FlowSpec) the same choice is
`"toolResultLimit": "auto"`, `"off"` or a whole number of kilobytes.

## Safety net, even when the switch is off

A single result may never take more than **half of the model's context
window**. A bigger result is still moved, with a note telling the model it was
too large for its context window. This keeps a run going instead of failing
with a "context too long" error. The same ceiling lowers a custom limit that is
larger than the model can take.

When a model does not state its context window, FLUJO assumes 128,000 tokens.
Then the safety ceiling is 256 KB and the automatic limit is 64 KB. Set the
context window on the model in **AI Setup** to get numbers that fit the model.

FLUJO counts four characters per token here, the same estimate it uses for
the rest of its context checks.

## Which runs it covers

The same rule applies everywhere FLUJO hands a tool result to a model:

- FLUJO's own tool loop (OpenAI-compatible, Anthropic, Gemini, OpenRouter,
  Ollama and other request-and-answer models),
- Claude (subscription), Codex and Antigravity runs, where the model's own
  program calls FLUJO's tools,
- the tool broker for Persona and execution-extension runs, which also keeps
  its own fixed 64 KB transport limit,
- conversations reloaded from history after an edit or a split (with the limit
  and model of the step that produced the result),
- a tool call that waited for your approval: it uses the conversation's store,
  the step's limit and the run's own owner, exactly like a call that needed no
  approval. A Bash session such a call starts now ends with the run, too.

Where a moved result is kept:

- A run that saves its conversation keeps it in that conversation.
- A subflow that does not save its conversation keeps it in the nearest saved
  conversation above it, usually the chat that started it. Its model reads it
  with `read_resource`, and so can the chat's own model later. Nothing about
  the subflow appears in the sidebar.
- A run with no saved conversation above it (an agent an outside program calls
  as a tool, a trigger check, a Harness experiment) keeps it in a store of its
  own, `unsaved-<run>`. FLUJO removes that store when the run ends; the hourly
  clean-up removes any a crash left behind.

## How it is checked

- `__tests__/flow/toolResultLimitRunPaths.test.ts` runs real flows against a
  stand-in model: an approved call, a step's own limit both ways, a subflow
  that saves nothing (including reading the result back), a run with nothing
  saved above it, and the clean-up.
- `__tests__/architecture/toolResultBoundSingleRule.test.ts` fails when a place
  that sizes tool results skips the step's own limit.
- `npm run check:tool-result-limit` (`scripts/tool-result-limit-check.mjs`)
  drives a throwaway FLUJO in a browser with a local stand-in model: it sets the
  limit in Settings, checks the error for `0` KB, runs an agent whose tool
  returns about 43 KB and sees the `flujo://run/` link, then sets the agent's
  step to "Keep results in full" and sees the full result instead. The
  `First-use journey` job of `verify-full.yml` runs it on the production build.

## For administrators

The setting is stored per workspace in `run_resource_settings` (fields
`toolResultTruncationEnabled`, `toolResultLimitMode`, `toolResultMaxBytes`,
`toolResultMaxLines`). `GET` and `PATCH /api/tool-result-limit` read and change
it; `PATCH` refuses unknown fields and values outside the ranges above. A
settings file written before this setting existed that sets
`toolResultMaxBytes` by hand keeps that number as a custom limit.
