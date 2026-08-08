# Persistent flow KV state

`${kv:NAME}` reads a small persistent value and `captureKv` writes one. KV is cross-run state: use `${var:NAME}` and `captureVariable` when a value only needs to travel between steps in the current run.

KV scopes are explicit when long-lived behavior matters:

- `folder/NAME` (or a bare `NAME`) shares a board with flows in the same folder.
- `flow/NAME` is private to one flow.
- `global/NAME` is shared by the whole FLUJO instance.

Folder boards are identified from a hash of the folder name. Renaming a folder therefore starts using a new board; it does not migrate existing values. Prefer `flow/` or `global/` when a key must survive a folder rename, and choose `global/` only when instance-wide sharing is intentional.

Missing, invalid, or unreadable values resolve to an empty string so a run can continue. Flow validation warns about invalid names; authors should make state dependencies explicit in the flow description or node instructions.
