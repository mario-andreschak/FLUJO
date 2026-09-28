# Chat commands and dynamic tool parameters

Use `@current` for a value from the executing conversation. These commands do not
open an entity hitlist. The server resolves them before sending text to the model
or dispatching a fixed tool parameter.

| Command | Value |
| --- | --- |
| `@current.conversation.id` | This conversation's ID, including Slack thread IDs |
| `@current.flow.id` | This flow's ID |
| `@current.node.id` | The node consuming the reference |
| `@current.model.id` | That Process node's bound model |
| `@current.app.id` | The MCP app/server in this execution context |
| `@current.folder.id` | This flow's folder |
| `@current.date.id` | Current date on the executing server, `YYYY-MM-DD` |
| `@current.time.id` | Current time on the executing server, `HH:MM:SS` |

The supported fields are `.id`, `.name`, `.created`, and `.updated`. Names and
timestamps come from the referenced entity when available. Date/time timestamps
are the current clock time in milliseconds. If current context or a requested
field is unavailable, the command stays literal instead of disappearing. There
is no implicit current file; select a file explicitly. `@current.flows` is accepted
as an alias for `@current.flow`.

## Select a specific entity

`@conversation`, `@flow`, `@node`, `@model`, and `@app` open their respective
pickers. Node choices in chat belong to the selected flow. Choose an item by name;
the stored reference includes its stable ID. A field suffix selects which value
will resolve: for example, `@flow.name` chooses a flow and stores its name reference.

Use `@conversation:budget`, `@flow:report`, `@file:README`, or `@folder:reports`
to search. `@@README` is the file/folder search shortcut. Existing `@c`, `@f`,
`@m`, and `@a` search shortcuts remain supported. Full command names take
precedence, so typing `@flow` no longer becomes a search for `low`.

Existing serialized references such as `@conversation.id`, `@flows[id].name`,
and `@file[path].updated` still resolve. Use `@current` in new flows to make
the distinction explicit. Current commands cannot contain a selected entity ID.

## Execution and hidden parameters

Ordinary chat and Slack messages use the same Process-node resolver. The model
receives resolved text; canonical conversation history retains the authored
reference. Static messages resolve when injected. Real Static calls also apply
server and node presets, with node values taking precedence.

Fixed parameters are removed from the model's tool schema and applied immediately
before dispatch. They override attempted model values and stay out of the
assistant tool-call history. An enabled empty-string preset is still fixed;
disable the preset to allow a model-selected test value.

These references provide context, not customer authorization. The existing
protected banking profile retains its separate authority restrictions.
`@_meta.fieldname` is a proposed follow-up for private run metadata; it is not
implemented by this change.
