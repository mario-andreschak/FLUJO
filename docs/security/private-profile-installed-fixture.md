# Installed private-profile fixture

The packed-artifact smoke previously waited for HTTP 200 from `/api/cwd` before running any encryption action. Fresh workspaces in the private-profile source deliberately return 423 `encryption_locked` from that route. The smoke must establish the private fixture through the real enrollment API before treating the effect route as ready.

This separate follow-up directly follows #694 at `3b7a655833396e0f76c266a350d3133fa9f2bf41`: frozen root `6390bc01`, source-only #632, #677 stable private reads, #668 business fixture replay and the worker fixture correction. Next remains locked to 16.3.8. Production routes, lock guards, encryption implementation, dependency manifests and assertion/skip allowances are unchanged.

The preceding Linux installed smoke in run `37174184550` timed out after the installed CLI reported readiness and migration completed without recorded errors. Its poll did not retain the last HTTP status and retained an earlier fetch error, so 423 is a source-supported explanation, not an observed cause of that run. This follow-up records the last successful HTTP status on timeout and clears stale fetch errors. The separate Windows `PlainFileReadError: UNSAFE_FILE` startup failure remains unresolved by this fixture change.

## Real installed sequence

Only the smoke's newly created immediate-child `flujo-packed-artifacts-*` temporary directory and its real `data` directory qualify. The helper refuses unrelated directories, aliases/leaf links, non-directories and non-loopback endpoints before any enrollment request. The installed child receives the fixture DataRoot, localhost exposure, worker mode disabled and no inherited operator passphrase-file selection.

The first installed CLI process must report uninitialized interactive protection with a locked fresh workspace. Its `/api/cwd` must return the fixed lock error. Public `initialize_default` must return 423 `encryption_setup_required` and leave the workspace fresh and locked. A newly generated 48-byte random private passphrase then enrolls USER protection through POST `/api/encryption/secure`; enrollment alone must leave the effect route locked. The passphrase remains in the helper closure, and the authentication token is checked without being returned or logged.

The helper reads the installed default workspace's bounded regular key metadata and requires USER v2, PBKDF2-SHA256 at 600,000 iterations, expected key/salt identifiers and a wrapped v2 envelope. It rejects plaintext passphrase bytes. Authentication must unlock the real effect route without replacing that metadata. Tokenless encryption of a fixed synthetic string must return a v2 envelope without that plaintext or passphrase. This checks encryption output shape; it does not independently decrypt the envelope or persist a secret store record.

The smoke stops the first CLI, starts a second CLI against the same fixture DataRoot, and must observe the existing USER workspace locked again. Metadata must remain byte-for-byte identical across restart and reauthentication before the existing packed MCP proxy probes run. A surviving unlocked process or a replaced key metadata file fails the restart check. The stdout receipt contains fixed outcome fields only.

The existing `--proxy-only` path for an operator-supplied running endpoint is unchanged. This fixture does not enroll or alter that endpoint. Existing packed filesystem, bash, browser and FLUJO child-process probes and real installed proxy probes retain their boundaries; they do not establish container isolation defaults.

## Checks and qualification limits

Windows Node 22.13.1 passed 30 private-profile helper controls using owned temporary files and controlled HTTP responses. Positive sequence/restart controls and negative fresh-state, public-setup, response size/JSON, metadata replacement, auth/ciphertext and owned-scope controls passed. The workflow contract rejects omitted/skipped artifact smoke and omitted/late private-profile controls. Together with the verification contract, 55 script assertions passed with zero skips; changed-file ESLint and diff checks passed. No full local Next build, broad Jest suite or actual installed application ran for this follow-up.

The production-build matrix now runs these helper controls before the actual packed-artifact smoke. Actual installed Linux/Windows qualification, root's composed intake, authenticated resumable four-store migration, operator-profile/browser enrollment, owner/BFF authentication, continuous revocation, default MCP isolation, human exercises and independent Security reassessment remain open. Source or helper controls cannot establish an A- outcome.

Earlier local scratch-image/context removals and an empty diagnostic fixture-directory removal were rejected by automatic approval review with `blocked by policy`. Those resources remain retained; this follow-up does not retry or claim their cleanup.
