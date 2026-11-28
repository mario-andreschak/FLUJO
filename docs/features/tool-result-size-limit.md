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
- conversations reloaded from history after an edit or a split.

Subflows that save their own conversation (the default) follow the setting.
A subflow set not to save its conversation has nowhere to store a moved
result. Its results stay in full, and FLUJO's normal context fitting shortens
them before the model would overflow.

A tool call that waited for your approval runs without the conversation's
resource store today, so its result is not moved at the tool. FLUJO's context
fitting still protects the next model request.

## For administrators

The setting is stored per workspace in `run_resource_settings` (fields
`toolResultTruncationEnabled`, `toolResultLimitMode`, `toolResultMaxBytes`,
`toolResultMaxLines`). `GET` and `PATCH /api/tool-result-limit` read and change
it; `PATCH` refuses unknown fields and values outside the ranges above. A
settings file written before this setting existed that sets
`toolResultMaxBytes` by hand keeps that number as a custom limit.
