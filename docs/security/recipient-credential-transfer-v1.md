# Recipient credential transfer v1

Ordinary backups omit credentials. This separate, deliberate transfer exports model configuration, MCP configuration (including OAuth credentials and all environment/header values), global environment variables, and registry credentials. It excludes the source encryption key, owner credentials/browser sessions, snapshots, host files, flows, and chats. Authored configuration strings may contain manually embedded secrets; treat the whole transfer as sensitive.

## Settings workflow

Settings → Backup includes a separate encrypted credential transfer panel. Enter a transfer passphrase and explicitly acknowledge that the file contains credentials before exporting. For restore, select the encrypted file, supply an unused destination name and a different local passphrase. Both passphrase fields clear after success or failure and when the selected workspace changes. Workspace changes cancel active requests and discard late download responses. Passphrases are transient form state, never browser storage or URL parameters.

## Export

`POST /api/credential-transfer?workspace=SOURCE` accepts JSON:

```json
{"confirmCredentialTransfer":true,"recipientPassphrase":"a distinct private recipient passphrase"}
```

Use an authenticated owner browser session or an owner bearer with `control:admin` and `secrets:read`. Export additionally requires a loopback Host, an allowed local Origin, a non-worker process, and unlocked source encryption. Pass the passphrase in the request body, never the URL or logs. The response is a `no-store` binary `.flujo-transfer` download. Store downloaded files privately; the server does not persist an export archive.

The encrypted envelope uses a random salt, PBKDF2-SHA256 (600,000 iterations), and AES-256-GCM with authenticated version/header/length. The transfer passphrase must contain at least 16 characters, at most 1,024 UTF-8 bytes, and cannot be the public legacy default. Use a randomly generated passphrase and share it independently of the file. Plaintext is bounded to 32 MiB. Source records are read from a coherent registered-writer capture with bounded, pinned, link-free reads. Existing v1/v2 envelopes and recoverable legacy plaintext markers are decrypted before transport encryption; corrupt envelopes refuse export without changing source data.

## Restore

`POST /api/credential-transfer/restore` accepts multipart fields `file`, `recipientPassphrase`, `localPassphrase`, `workspace`, and `confirmCredentialTransfer=true`. The same owner and strict-loopback authority applies. Restore can run while the selected existing workspace is locked because it never reads its credentials or overwrites its key.

Choose an unused workspace name and a different local passphrase (at least 12 characters, at most 1,024 UTF-8 bytes, never the public default). Restore authenticates the envelope and expiry before staging. It creates a fresh random recipient key, encrypts recognized credential fields and every environment/header value under that key, validates ciphertext round trips, and writes private files in an unselectable staging directory. Publication holds the installation namespace lock and renames the complete tree atomically; case-equivalent existing workspace names are refused. Files request mode 0600 and directories 0700. POSIX publication syncs the parent directory. Windows deployments must provide private ACLs; POSIX modes do not establish Windows ACL isolation.

Successful response contains only the new workspace name and `encryptionProtection: passphrase`. Unlock that workspace with the local passphrase after restart. The source key is neither transferred nor reused. MCP configurations are restored disabled; review connections, host paths, permissions and OAuth grants before enabling them. Packages, files and capability grants are not transferred.

Transfers expire for import after 24 hours. Expiry does not erase an archive or revoke already imported credentials; anyone retaining its file and passphrase can decrypt it. Delete unused downloads and share passphrases separately. Failure before publication removes the same owned staging directory and preserves source/existing destination bytes. A process crash can leave a private, unselectable `.credential-transfer-*` directory containing recipient ciphertext and wrapped metadata; this version does not automatically reclaim crash remnants. After successful publication, rollback uses ordinary deletion of the new workspace; source data remains intact. Credentials copied to a recipient may require provider-side rotation or revocation separately.

## Validation boundary

OAuth bundles use the runtime’s full SDK envelope parser and serializer. Export validates the source workspace and purpose; restore rebinds the complete SDK value to the recipient workspace, including unknown provider extensions and private JWKS. Older whole-envelope transfers created without source binding validation must be re-exported; legacy field-encrypted transfers remain readable.

Source tests cover mixed v1/v2/plaintext conversion, wrong passphrase, tampering, expiry, interrupted staging/publication, collisions, corrupt source refusal, actual owner/Origin/confirmation/lock HTTP gates, and restore plus restart unlock in separate Node processes. These are source tests, not installed-artifact, human, or external acceptance. This feature does not implement resumable in-place migration of existing workspaces or change the trusted single-owner deployment contract.
