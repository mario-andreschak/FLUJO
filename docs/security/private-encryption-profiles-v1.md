# Private encryption profiles and legacy recovery

Custom passwords are optional for ordinary local use. A fresh store is unlocked
and lazily creates a random data key using the existing default-encryption
format when credentials are first saved. Its public `DEFAULT_PASSWORD` wrapping
is compatibility/obfuscation, not private protection. The owner can opt into
passphrase protection in Settings, using credential migration when default
credentials already exist. Decryption never invents replacement metadata.
Owner authentication remains separate from encryption unlock.

Optional password setup is available in Settings; it never blocks first launch.
The unlock dialog appears only for existing locked profiles or recovery errors.
The passphrase is transient browser
state, cleared after each submitted attempt, and never stored in browser storage
or server metadata. The UI requires at least twelve characters. Server sessions
carry the existing unlock capability; browser flags cannot assert server unlock.
Loss of the passphrase requires a matching protected recovery backup, not a reset
that replaces the key and strands ciphertext.

Headless/container installs can set `FLUJO_ENCRYPTION_SECRET_FILE` to an absolute
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

The process retains at most 16 completed, authenticated operator keyring unwraps,
independently scoped by workspace. The least recently used entry is evicted when
that bound is reached; ordinary access in another workspace does not replace a
currently retained entry.
Reuse still reads the complete current metadata and migration state, validates and
rereads the bounded independent secret file, and checks the named/canonical
workspace root and its filesystem identity on every access. The identity includes
the complete metadata revision, data-key ID, current secret digest, and validated
mount path/file/permission identity. It never treats a browser flag, generic server
unlock, token, elapsed time or matching workspace name alone as authority.
Changes force a canonical 600,000-iteration unwrap; cold derivations recheck the
current inputs before publishing a result. A lock, unlock, session creation,
revocation/expiry, migration denial, profile change or failed access invalidates
that workspace's reuse and prevents an earlier derivation from repopulating it.
Observed expired sessions revoke their issuing workspace's entry even when
cleanup runs in another workspace. There is no TTL.
Transferred-worker provenance retains its separate fresh validation path; a cached
operator key never substitutes for a missing mount or valid transfer provenance.

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
not private protection. The implemented [credential migration](credential-migration-v1.md)
preflights recognized model, registry, global environment and MCP credential
stores, writes an authenticated encrypted recovery journal, and rewrites supported
plaintext/v1/v2 values under private protection. It supports verified resume and
rollback. Migrating a public-default wrapper generates a fresh active v2 data key;
already private v2 profiles retain their key unless explicit retirement is selected.
Legacy read keys and historical archives retain their documented compatibility.

Ordinary backups omit recognized structured credentials; secrets embedded in
user-authored prose or code can remain, so review and protect archives before
sharing. Deliberate [recipient credential transfer](recipient-credential-transfer-v1.md)
uses recipient protection and a fresh destination key. Historical snapshots and
existing exports remain outside in-place migration; copied credentials may need
provider-side revocation separately. Complete operator-secret rotation and worker
restore qualification retain their own requirements. A restored operator profile
requires its independently provisioned matching mount; a snapshot alone supplies
no replacement protection secret. Deliberate operator worker capture validates
the matching independent mount against the captured metadata, as described below;
it must not substitute the mount secret into snapshot material.
Source tests and temporary source processes
do not establish installed-artifact, human or independent external acceptance.

### Operator worker snapshots

Deliberate worker snapshot capture authenticates the independently mounted operator secret against the exact captured encryption metadata; it does not require or create a browser unlock session. The private bootstrap key is confined to the deliberate worker archive. The worker must independently mount the matching operator secret outside its data directory. A copied bootstrap key never substitutes for that mount: missing or changed mounts keep operator-profile decryption locked, including after restart. Snapshot capture refuses mismatched metadata or unavailable mounts without exposing secret values in its error.
