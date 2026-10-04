# Private key protection source follow-up for #567

This slice follows #619 at `addf22fed5fae98b2f0cc04793c200d244b413d3` and composes
the OAuth boundary/type fixture follow-up #613 at
`7ca0402afb4deea87bd6cbdfe12e147e53e8bf8a`. Captured prior heads and root's
release candidate are unchanged. Root owns integration, full semantic checks,
packed/installer/container qualification and deployment. This is an incremental
source implementation, not the completed #567 acceptance or an A- assessment.

## Protection contract

Fresh workspaces cannot silently create public-password metadata. Without a
configured operator file they return the encryption lock response until an
explicit interactive passphrase is initialized and authenticated. The server
rejects the published compatibility password for initialization/password changes.
The setup dialog confirms its 12-character-minimum UI passphrase, waits for the
initialization acknowledgement after atomic metadata rename, then authenticates. A failed save
does not authenticate or replace previously committed metadata. Server status,
not a cached browser flag, selects setup/unlock/recovery. Status contains only
booleans, mode and protection classification; no secret, token or file path.

Headless installs use `FLUJO_ENCRYPTION_PASSPHRASE_FILE`. The regular unlinked file
must be absolute, outside the complete canonical data root, contain 32–1024
UTF-8 bytes (one terminal newline allowed), and have no embedded newline/NUL.
Invalid UTF-8, malformed/unavailable/short/oversized inputs deny access. POSIX
owner and owner-only mode are enforced. Windows ACL provisioning is an operator
responsibility and has not been certified by the Windows source suite.

The operator must supply a generated secret through an independently protected
secret-manager mount or equivalent system. A secret file beside data is rejected;
a different pathname on its own does not prove independence. No OS keystore was
implemented. The application does not write the operator passphrase to disk or
return it to the browser. It holds the unlocked data keyring in server memory,
as the existing encryption runtime does. This boundary does not protect against
code with the server's OS privileges, an already authorized operation using the
unlocked key, or a compromised secret-manager/host.

The file is bounded and re-read for operations, with open/path identity and
size/mtime/mode/owner/link-count consistency checks. A process-memory digest binds
the unlock cache to both complete metadata and operator contents; the password
itself is not cached there. Missing/mismatched replacements clear server unlock
and deny tokenless operations rather than falling back to a previously unlocked
key. Matching recovery reuses the committed keys. Rotation rewraps metadata and
requires an operator-file update before unattended access resumes. Explicit
interactive password verification remains available to the authorized control
route. Operator recovery UI displays status/retry without a password field.

Initialization, metadata upgrade and password changes compose the existing
filesystem-backed workspace runtime lock with their local/HMR queue. Two fresh
source processes can no longer independently mint and overwrite first-write
keys. The same data keys remain readable after metadata password changes.

Existing DEFAULT/v1/v2 reads remain compatible. Existing DEFAULT behavior without
operator protection still uses the public compatibility password; this is an
open legacy risk, not a private profile. Operator selection refuses that metadata
until explicit rewrapping. Rewrapping retains the legacy key and does not claim a
bulk rewrite. Missing metadata beside recognized credential fields/envelopes or
invalid credential files refuses fresh initialization. The bounded four-store
guard directs recovery to matching metadata/backup or explicit migration; it is
not a complete inventory of arbitrary secrets in flows, code or external stores.

Key/credential JSON reads use bounded strict parsing without generic storage's
raw parser diagnostics or automatic corrupt-input copies. Corrupt metadata is
retained, errors are fixed, and no replacement key is created. The encryption
control route also returns/logs fixed failures instead of parser input. Ordinary
single/batch environment views now mask historical plaintext records flagged as
secret; the explicit authorized `includeSecrets=true` operation retains its
existing behavior. These changes do not certify every application log or browser
surface.

## Source evidence

Checkout-local Node 22.13.1, Next 16.3.5 and TypeScript 6.0.3 on Windows x64 were
used. No dependency, shared test-runner or installed-artifact inputs changed.
Commands use the ignored Windows test-discovery override from the earlier
Security slices. Root retains the full typecheck/build slot; only the bounded
private-profile helper scope includes Next ambient types locally. Full semantic
typecheck/build/CI for this new source revision remains pending.

The seven backend suites passed 69 tests, with the POSIX permission case skipped
on Windows. After replacing a broad utility barrel import with its direct common
helper, the exact final private-profile suite passed all 20 Windows cases again,
including both fresh OS-process probes. Seven DOM setup/recovery cases passed.
The private-profile helper scoped typecheck including Next ambient types,
changed-file ESLint and `git diff --check` passed. This is 76 passing test cases
with one platform skip across the affected suites; full application checks and
power-loss/fsync durability qualification remain pending.

```powershell
node scripts/run-local-jest.cjs --config .tmp/owner-jest.config.mjs --selectProjects node --runInBand __tests__/encryption/privateProfile.test.ts __tests__/encryption/serverUnlock.test.ts __tests__/encryption/dekInvariant.test.ts __tests__/encryption/apiKeyRoundTrip.test.ts __tests__/encryption/lockGate.test.ts __tests__/encryption/credentialFailure.test.ts __tests__/encryption/envCredentialFailure.test.ts
node scripts/run-local-jest.cjs --config .tmp/owner-jest.config.mjs --selectProjects jsdom --runInBand __tests__/frontend/components/EncryptionPrivateSetup.test.tsx
```

The backend cases use real crypto/storage in owned temporary workspaces, including
two fresh OS processes sharing one workspace/operator file. Their synthetic
credentials survive concurrent first writes and a restart. The child fixture
transpiles source at runtime; it is not an installed Next server or release
artifact. DOM component tests use mocked storage/status operations and prove
setup ordering, lock/recovery UI decisions and absent operator-secret input;
they are not browser pairing or human acceptance evidence.

Failed runs retained: the first affected four-suite run passed 34/35 tests but
failed an old public-default first-write expectation, with a fixture cleanup
race after early Promise rejection. It was replaced with explicit private setup
and added operator/process concurrency coverage. A subsequent seven-suite run
passed 49 existing cases but could not load the new test's incorrect helper
import. The new test now uses a real NextRequest, and later runs passed those
cases. Automatic approval review rejected deletion of the leftover first-run
temporary fixture with “blocked by policy”; that artifact was left in place.

## Remaining acceptance

Resumable authenticated migration still needs complete models/registry/env/OAuth/
MCP/snapshot-bootstrap inventory, encrypted recovery backup, per-record integrity
validation, writer fencing, interruption/resume/rollback and a durable commit
protocol. This source slice does not rewrite historical plaintext, CBC values,
OAuth tokens or the PKCE verifier. Ordinary backup/snapshot downloads still need
a credential-free default and a separate encrypted, recipient-keyed transfer.
Worker restore, all enrollment/lock/unlock journeys, exact installed artifacts,
operator permissions, human acceptance and independent reassessment remain open.
