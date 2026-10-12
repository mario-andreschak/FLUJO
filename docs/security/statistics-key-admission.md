# Persistent statistics key admission

Statistics credential groups and revision identities use the same durable
`.installation-key` as before: 32 bytes created with `randomBytes(32)`, HMAC-SHA256,
base64url, and the existing 22-character suffix. Valid existing bytes are read
unchanged. This change does not rotate keys, migrate records or alter identities.
A length check establishes the stored key format, not entropy of preexisting bytes.

The loader admits a regular, single-link, exactly 32-byte file. Descriptor and
named-file identities, including BigInt timestamps, must agree before and after
bounded reads. An existing unsafe or changing file fails with a generic error;
there is no chmod, repair, deletion, retry or replacement. Only absence at the
first leaf admission permits exclusive creation with mode 0600. Both a successful
publication and an EEXIST winner undergo the same read admission before HMAC use.
A racing creator's incomplete publication is denied; the loader does not retry
until it becomes valid or rewrite it to recover availability.

On POSIX, the file must belong to the effective process user (falling back to the
real user only when effective-user support is absent), with no group/other mode
bits. Owner-readonly legacy keys remain valid. The immediate statistics directory
must be a real directory owned by that user, with no group/other write bits; an
existing 0755 directory remains valid. Newly created directories request 0700.
Directory identity, owner, mode and canonical target are rechecked around reads
and creation. Child writes may change directory timestamps without denial.

On Windows, Node uid/mode fields do not establish owner or ACL privacy. The loader
still checks type, links, size, descriptor identity and directory target; it does
not claim native ACL validation. Tests that model POSIX metadata on Windows test
policy branches only. See [Node 22 filesystem documentation](https://nodejs.org/docs/latest-v22.x/api/fs.html).

The selected workspace and its ancestors remain a trust boundary. Path rechecks
are not an OS sandbox or descriptor-relative directory creation; same-user code,
ancestor replacement between checks and full process-memory compromise are not
excluded. Admitted keys retain the existing per-directory promise cache for the
process lifetime; this does not revalidate disk permissions for every fingerprint.
Denied promises remain cached as before. Existing best-effort callers can omit
optional credential/revision metadata without changing provider execution.

This Source proposal authors regressions but claims no executed test, typecheck,
lint or native clearance. Original #120 disposition requires independent review;
this is durable-key admission hardening, not password-verifier conversion.
