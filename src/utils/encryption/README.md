# Workspace secret encryption

FLUJO stores provider keys, registry tokens and secret environment variables in the selected workspace. Password encryption protects stored secrets while the workspace is locked. It is not HTTP authentication: once unlocked, authorized local backend operations can use the keys until the process stops or the workspace is explicitly locked.

## Current format (version 2)

New data-encryption keys contain 32 cryptographically random bytes from Node's `crypto.randomBytes`. Secrets use AES-256-GCM with a fresh 12-byte nonce and a 16-byte authentication tag. The stored payload is `v2:nonceHex:tagHex:ciphertextBase64`, normally inside the existing `encrypted:` application envelope. A changed nonce, tag, ciphertext or format is rejected.

The password wraps a versioned keyring using AES-256-GCM. PBKDF2-HMAC-SHA256 derives a 32-byte wrapping key using a fresh 16-byte salt and 600,000 iterations. Authenticated associated data binds the envelope to its purpose, format version, encryption mode and key identity. Metadata is atomically replaced only after the wrapped keyring is complete; concurrent initialization and metadata changes are serialized per workspace.

Fresh workspaces require private setup before credential operations. Interactive installs use an explicit passphrase; the browser setup dialog confirms it, waits for durable initialization, then authenticates. The server rejects the public compatibility password for initialization and rotation. No missing key file silently creates a public-password profile. Missing key metadata beside recognized credential data requires matching recovery or explicit migration and cannot mint a replacement key.

For headless installs, set `FLUJO_ENCRYPTION_PASSPHRASE_FILE` to an absolute regular file outside the entire FLUJO data tree. Supply 32–1024 UTF-8 bytes, optionally followed by one newline; use a generated high-entropy secret. Keep it in an independently protected secret-manager mount or equivalent boundary, with POSIX owner-only permissions or an operator-managed Windows ACL. A different pathname alone is not independent protection. Linked files, short/oversized/multiline/invalid input, and files inside the data tree are rejected. The file is re-read for operations; loss or a mismatched replacement clears the server unlock and denies tokenless access. Rotation requires updating both wrapped metadata and the operator file; matching recovery retains the data keys. The browser never asks for the operator file's secret.

**Existing default mode is storage obfuscation, not protection from someone who can read the workspace files.** Its published compatibility password remains for legacy reads and existing-profile behavior until explicit migration. Selecting operator protection for that existing profile denies access until its metadata has been explicitly rewrapped. Rewrapping alone does not authenticate old CBC records or encrypt historical plaintext. Neither profile protects secrets from code already running as the same OS user while the workspace is unlocked.

## Legacy data and upgrades

Version 1 used an eight-random-byte key represented as hexadecimal text and unauthenticated AES-CBC. It remains readable for compatibility, with exactly its original effective key representation. Legacy ciphertext cannot gain authentication retroactively.

On first access in default mode, or successful password authentication in user mode, FLUJO atomically replaces v1 metadata with an authenticated v2 keyring containing a new 32-byte active key and the old effective key for reads. Existing secret files are not bulk rewritten. Newly entered or replaced secret values use v2; old CBC values remain readable. Saving a record with an unchanged masked credential may retain its existing ciphertext. User-mode sessions left over from an older running build must authenticate again before writing secrets.

Password changes and default-to-user transitions rewrap the complete keyring without changing its existing keys. Mixed legacy/new values remain readable after restart and with a matching backup. Restore complete workspace backups including `db/encryption_key.json`; restoring old metadata without the corresponding secret files can lose access to values written after that backup. Take a backup before upgrading. Old FLUJO builds cannot read v2 metadata or ciphertext, so downgrading requires restoring a complete pre-upgrade backup.

Historical `encrypted_failed:` values contain plaintext. They are not produced by any encryption helper. Existing values retain read compatibility until explicitly replaced; upgrading the keyring does not encrypt these existing plaintext records. Explicitly re-save an affected model to encrypt its existing credential; sign in again to replace an affected registry account; re-enter and save each affected secret environment variable. An unchanged `********` environment-variable placeholder preserves the old value, so clicking Save without entering the secret does not repair that record. Failed encryption aborts the entire save and retains the old stored record, including all prior values in a batch environment-variable update. It never persists the submitted plaintext as a fallback.

## Runtime/session behavior

Session and server unlock state are workspace-scoped and contain a serialized v2 keyring (or a legacy effective key during compatibility reads). Session tokens expire after two hours from creation. The separate server unlock state has no timer, allowing background execution to continue after the UI session expires. Invalidating a UI token does not lock the server. Tokens and plaintext keys are not written to logs.

Worker snapshots carry the complete unlocked keyring inside their private bootstrap secret file, so old/new ciphertext remains readable in the restored workspace. Such snapshots contain credentials and must be handled as secrets.

Upgrade worker hosts before transferring a migrated workspace. Older worker builds cannot interpret a v2 keyring. An existing empty or malformed metadata file is an error, not an empty workspace: restore it from a matching backup instead of deleting it or generating a replacement key.

## Code and verification

- `format.ts`: authenticated envelopes, password key derivation, strict format validation and v1 read compatibility.
- `secure.ts`: workspace metadata lifecycle, atomic upgrade, password transitions and encryption/decryption API.
- `session.ts`: workspace-scoped sessions and server unlock state.
- `privateProfile.ts`: bounded operator-file admission and public-password rejection.
- `workspaceFiles.ts`: strict credential-file reads and missing-metadata recovery guard; this is not a complete migration inventory.
- `lockGate.ts`: HTTP 423 while setup is required or private protection is locked/unavailable.
- `__tests__/encryption/privateProfile.test.ts`: real workspace and two fresh OS-process source probes for private setup, restart, file loss/replacement, rotation and recovery.
- `__tests__/encryption/dekInvariant.test.ts`: real temp-directory crypto tests for legacy/new reads, upgrade interruption, backup/restore, restart, password changes, tamper rejection and concurrent initialization.
- `__tests__/encryption/credentialFailure.test.ts`: failure-path tests ensuring model and registry saves preserve previous credentials.
- `__tests__/encryption/envCredentialFailure.test.ts`: single and batch environment-variable writes preserve all old values when encryption or initialization fails.

Decryption returns `null` for invalid ciphertext or credentials; a locked workspace throws `EncryptionLockedError`. Credential-writing helpers throw when encryption cannot complete. Callers must propagate that failure and leave their existing persisted record intact.

The profile follow-up does not complete #567: resumable bulk migration, ordinary credential-free exports, encrypted recipient transfer, worker/bootstrap qualification and installed/human/independent evidence remain open. See `docs/security/private-key-profile-v1.md` for its source evidence and limits.
