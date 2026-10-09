# Ordinary workspace backup

`POST /api/backup` creates a ZIP for the selected workspace after owner, unlock and local-request checks. Persona-attributed conversation snapshots additionally require strict loopback access.

```json
{"selections":["models","mcpServers","flows","chatHistory","settings","globalEnvVars"]}
```

These six selections are allowed. Duplicate selections are collapsed; unsupported selections are excluded. An empty effective selection returns 400. Requests containing only `encryptionKey` or `mcpServersFolder` return 400. Selecting either alongside an allowed component never reads or exports the encryption metadata or raw server folder.

The ZIP retains `backup-info.json` and `storage/<storage-key>.json`, plus modern `storage/conversations/<id>.json` entries. Metadata records `credentials: "omitted"`, the effective selections and omitted legacy selections. Responses use `Cache-Control: no-store`.

Ordinary exports omit recognized credential fields and encrypted/failed-encryption envelopes recursively. Model endpoint fields are omitted because endpoints can embed credentials. Global variables retain names with empty values and secret metadata; no variable values are exported, including unmarked legacy values. MCP entries retain descriptive metadata only (name, transport, description, folder, favorite, disabled); launch commands, arguments, environment, HTTP headers, URLs, OAuth state and arbitrary nested transport options are excluded.

Restoring these ordinary archives requires reconfiguring credentials and connections. The export does not update stored values; existing legacy corruption recovery can create a diagnostic backup file. User-authored flow/chat text and descriptive metadata are preserved; a credential embedded in prose or code is not detected by this structural filter. Review that content before sharing.

Older ZIPs remain readable by the existing restore endpoint, including its existing explicit legacy selections. Ordinary backups do not migrate stored ciphertext or rotate keys. Deliberate encrypted recipient transfer uses separate endpoints and fresh recipient keying; see [the transfer contract](../../../../docs/security/recipient-credential-transfer-v1.md). Installed-artifact qualification and resumable in-place migration remain separate work.

## Partial archive outcomes

Successful ZIP responses retain HTTP 200 and the version `1.0` entry layout. Additive `backup-info.json` fields include `status` (`complete` or `partial`) and `selectionResults`, keyed only by accepted selections with `completed`, `empty`, or `failed` values. Empty selections are distinct from failures. A partially saved selection is marked `failed`; the archive can still contain its successfully serialized entries. No exception text, file paths, or failed record identifiers are included in this outcome metadata.

`X-Flujo-Backup-Status` mirrors the archive status. Backup Settings downloads partial archives and displays a warning rather than complete-success messaging. If an export has failures and no data entries, it returns a generic HTTP 500 instead of a metadata-only partial ZIP. An entirely empty, error-free export remains compatible with HTTP 200.

Flows are read from authoritative legacy storage and strict modern collection snapshots, with modern records winning by ID. This path validates flow snapshots, preserves live-owner visibility, and does not use the UI flow cache or run flow migration. The existing legacy `loadItem` corruption recovery may write a `.corrupted.*.bak` file; this is not an entirely side-effect-free filesystem read. Strict chat-history reads must succeed before Persona authority preflight and archive construction; unreadable history fails closed. Individual later serialization failures are recorded and do not prevent remaining safe entries from being saved.
