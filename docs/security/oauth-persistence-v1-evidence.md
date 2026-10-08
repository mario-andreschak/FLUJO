# OAuth credential acknowledgement and logging evidence

October 3, 2026. #567 bounded source remediation, based on
`3511ba49514fe8cf525f5a22c16c3806bf3886ba`.
Branch: `codex/scorecard-oauth-secret-boundary`; commit identity is the PR head
containing this document. This change is independent of the owner-auth PR #582.

## Behavior and limits

Dynamic client-registration payloads, token payloads (including unknown provider
extensions such as `id_token`), and authorization URLs are no longer rendered
by the OAuth provider's logger. Client/token writes emit fixed presence flags.
Storage failure text is not logged or attached as an error cause at this boundary.
This does not establish coverage of every lower-level storage/SDK logger or
remove credentials from historical logs.

Credential changes and explicit invalidation are staged and copied into the
active config only after storage returns success. Unreadable configs, rejected
saves and thrown storage errors reject the SDK callback with a fixed error;
they never emit a successful-save message. A remote authorization server may
already have rotated its token before local saving fails. Retaining old local
state does not prove the remote grant is still usable, and reauthorization may
be required. The change adds no automatic replay or retry permission.

The existing persisted credential shapes and expired-access/refresh-token behavior
are preserved. In particular, this PR does **not** encrypt legacy/plaintext MCP
OAuth token sets, dynamic client secrets or PKCE verifiers, inventory every
credential location, change the public default encryption password, or complete
#567. Verified migration, private key protection, ordinary credential-free
exports, deliberate encrypted transfer and restart/rotation/recovery acceptance
remain required. No installed-artifact or independent-grade acceptance is claimed.

## Executed source checks

Owned Windows x64 checkout with its own locked dependency install: Node 22.13.1,
Next 16.3.5, TypeScript 6.0.3, Jest 30.4.2. All inputs were synthetic. Tests used
the same temporary managed-Windows explicit-match runner workaround documented
in PR #582 (SHA-256
`3b4be15b023d68c8585e1e59df293f02944b089198a8e2624286696c111e1e1a`).
Engineering owns the shared runner fix.

- `oauthCredentialBoundary.test.ts`: ten tests passed, exit 0. Covers unknown
  token-extension redaction, client-secret redaction, authorization-URL redaction,
  acknowledgement ordering, failed writes for token/client/verifier/invalidation,
  failed reads, thrown-error redaction and successful invalidation.
- Existing `oauthRefreshPersistence`, `oauthManualClient`,
  `mcpOauthCallbackIsolation` and `oauthStateIsolation`: nine tests passed,
  four suites. Manual-client SDK requests use a synthetic fetch fixture.
- ESLint of the changed OAuth source and new test passed with no warnings;
  `git diff --check` passed.

The initial five-suite command exited 1: the four existing suites passed, but
the new suite failed to initialize because its logger mock referenced a
not-yet-initialized variable. Moving logger construction into the mock factory
resolved it; the standalone ten-case suite then passed. The initial zero-run
new suite is not counted as acceptance.

```text
node scripts/run-local-jest.cjs --config .tmp/owner-jest.config.mjs --selectProjects node --runInBand __tests__/mcp/oauthCredentialBoundary.test.ts
node scripts/run-local-jest.cjs --config .tmp/owner-jest.config.mjs --selectProjects node --runInBand __tests__/mcp/oauthCredentialBoundary.test.ts __tests__/mcp/oauthRefreshPersistence.test.ts __tests__/mcp/oauthManualClient.test.ts __tests__/workspace/mcpOauthCallbackIsolation.test.ts __tests__/workspace/oauthStateIsolation.test.ts
node node_modules/eslint/bin/eslint.js src/backend/services/mcp/oauth.ts __tests__/mcp/oauthCredentialBoundary.test.ts --max-warnings=0
git diff --check
```

Root/MCP typechecks, full suites, Windows/Linux builds and packed/installed-client
acceptance remain pending for this PR. The passing root typecheck reported for
PR #582 does not cover this different source revision. The coordinator reserved
the heavy slot for current dependency remediation; the historical clean audit
does not qualify this branch. Independent review and exact release acceptance
remain open.
