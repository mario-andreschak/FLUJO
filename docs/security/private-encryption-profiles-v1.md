# Private encryption profiles and legacy recovery

Fresh stores never create key metadata wrapped with the public `DEFAULT_PASSWORD`.
Without an explicit passphrase or protected operator mount, credential writes
fail closed and leave metadata absent. Decryption never invents replacement
metadata. Owner authentication remains separate from encryption unlock.

Interactive setup collects and confirms a passphrase in the encryption dialog,
then initializes and unlocks the workspace. The passphrase is transient browser
state, cleared after each submitted attempt, and never stored in browser storage
or server metadata. The UI requires at least twelve characters. Server sessions
carry the existing unlock capability; browser flags cannot assert server unlock.
Loss of the passphrase requires a matching protected recovery backup, not a reset
that replaces the key and strands ciphertext.

Headless/container installs set `FLUJO_ENCRYPTION_SECRET_FILE` to an absolute
operator-provisioned regular file outside the complete application data tree.
Provision at least 32 random bytes encoded as base64url (43 characters); a single
trailing newline is allowed. Mount the file separately from data and snapshot
volumes. It is never generated beside ciphertext or copied into the data tree.
The reader rejects links, hard links, overlong/invalid records and paths within
either the named or canonical data root. It bounds one descriptor and checks
file/path identity before and after reading, with nonblocking/no-follow flags.
POSIX requires the current operator UID and no group/other permissions. On
Windows, the operator must provision an owner-only ACL; Node mode bits do not
verify Windows ACLs. Windows ACL enforcement and installed isolation acceptance
remain unqualified.

Private keyrings use AES-256-GCM wrapping with PBKDF2-SHA256, a random salt and
600,000 iterations. `key_protection` is authenticated as additional data, so
removing/changing the profile marker fails verification. Data-key identity stays
stable when a passphrase changes. Operator profiles reread the independent
mount instead of trusting browser passwords or cached unlock state. A missing
or changed mount fails closed without replacing metadata or ciphertext; restore
the matching protected secret to recover. Operator-secret rotation must retain
matching old metadata/secret backups until the new pair is verified; automated
resumable operator rotation is still pending.

Passphrase unlock capabilities bind the complete committed metadata revision.
Changing the wrapper or profile marker invalidates cached unlock authority;
passphrase rotation invalidates old unlock tokens while preserving the data key.

Fresh initialization writes and syncs a complete staged record, then uses an
atomic no-replace hard link to elect one key across OS processes. Competing
writers read the committed record; they cannot overwrite another fresh key.
Filesystems without the required atomic operation fail closed. A crash may leave
an encrypted staged record for operator cleanup, but never exposes a partial
committed key record or authorizes a credential write under an uncommitted key.

Existing v1/v2 `default` metadata remains readable as **legacy compatibility**,
not private protection. Explicit passphrase migration rewraps the existing
keyring, retains legacy keys and atomically replaces metadata. It does not yet
rewrite mixed legacy ciphertext or historical plaintext. Existing password
profiles and recoverable backups retain their read compatibility.

Further #567 work includes complete credential inventory (model keys, registry
accounts, secret environment values, OAuth/MCP auth, snapshot/bootstrap material),
resumable bulk migration with preflight/backup/integrity verification, credential-
free ordinary exports, encrypted recipient transfer, complete operator rotation,
and worker restore under each declared profile. A restored operator profile
requires its independently provisioned matching mount; a snapshot alone supplies
no replacement protection secret. The existing snapshot capture path still
expects an interactive unlock capability; operator capture/transfer integration
is pending and must not substitute the mount secret into snapshot material.
Source tests and temporary source processes
do not establish installed-artifact, human or independent external acceptance.
