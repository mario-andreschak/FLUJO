# Ordinary workspace backup

`POST /api/backup` creates a ZIP for the selected workspace after owner, unlock and local-request checks. Persona-attributed conversation snapshots additionally require strict loopback access.

```json
{"selections":["models","mcpServers","flows","chatHistory","settings","globalEnvVars"]}
```

These six selections are allowed. Duplicate selections are collapsed; unsupported selections are excluded. An empty effective selection returns 400. Requests containing only `encryptionKey` or `mcpServersFolder` return 400. Selecting either alongside an allowed component never reads or exports the encryption metadata or raw server folder.

The ZIP retains `backup-info.json` and `storage/<storage-key>.json`, plus modern `storage/conversations/<id>.json` entries. Metadata records `credentials: "omitted"`, the effective selections and omitted legacy selections. Responses use `Cache-Control: no-store`.

Ordinary exports omit recognized credential fields and encrypted/failed-encryption envelopes recursively. Model endpoint fields are omitted because endpoints can embed credentials. Global variables retain names with empty values and secret metadata; no variable values are exported, including unmarked legacy values. MCP entries retain descriptive metadata only (name, transport, description, folder, favorite, disabled); launch commands, arguments, environment, HTTP headers, URLs, OAuth state and arbitrary nested transport options are excluded.

Restoring these ordinary archives requires reconfiguring credentials and connections. The export never modifies the source stores. User-authored flow/chat text and descriptive metadata are preserved; a credential embedded in prose or code is not detected by this structural filter. Review that content before sharing.

Older ZIPs remain readable by the existing restore endpoint, including its existing explicit legacy selections. This change does not migrate stored ciphertext, rotate keys, provide an encrypted recipient transfer, or qualify an installed artifact. Those remain separate work.
