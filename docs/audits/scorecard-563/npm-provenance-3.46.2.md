# Historical npm provenance verification: 3.46.2

On October 4, 2026 UTC, GitHub CLI 2.96.0 cryptographically verified the
published `flujo-ai@3.46.2` tarball against its npm registry Sigstore bundle.
The tarball's SHA-512 matched current registry integrity and the verified
attestation subject. Its SHA-256 was
`470605df68d8d2afb1db4895ec3d51e2be1a4d0ba93805becad86733ae71135c`;
its size was 10,286,028 bytes.

The exact verification policy required:

- the official `mario-andreschak/FLUJO` repository;
- certificate identity
  `https://github.com/mario-andreschak/FLUJO/.github/workflows/publish-npm.yml@refs/heads/main`;
- OIDC issuer `https://token.actions.githubusercontent.com`;
- source and signer digest `320347356891aa1c24e0f2f9ce12719317e58bde`;
- source ref `refs/heads/main`, SLSA v1 provenance and GitHub-hosted runners.

The verified certificate carried those source, signer, issuer and runner values.
The retained verification output includes a verified Rekor timestamp at
`2026-10-02T15:30:21Z` and invocation
`https://github.com/mario-andreschak/FLUJO/actions/runs/37023576093/attempts/5`.
The positive command exited 0. Six controls changed only the source digest,
signer digest, source ref, issuer, certificate identity or one tarball byte;
each exited 1. The altered tarball was never executed and was removed after
its mutation and hash were recorded.

Raw public evidence is retained under
[evidence/npm-provenance-3.46.2](evidence/npm-provenance-3.46.2/controls-receipt.json):
the exact-policy/negative-control receipt, verified output and complete Sigstore
bundle. The receipt contains the actual commands, tool version/binary digest,
diagnostics and stdout/stderr hashes. Git attributes preserve these bytes.
The full tarball remains external; the hashes above identify it for replay.

To repeat the positive check, fetch the exact public tarball into a fresh
directory and verify its size, SHA-256 and SHA-512 against the receipt before
using the retained bundle:

```text
gh attestation verify <flujo-ai-3.46.2.tgz> --bundle docs/audits/scorecard-563/evidence/npm-provenance-3.46.2/npm-provenance.sigstore.json --repo mario-andreschak/FLUJO --predicate-type https://slsa.dev/provenance/v1 --cert-identity https://github.com/mario-andreschak/FLUJO/.github/workflows/publish-npm.yml@refs/heads/main --cert-oidc-issuer https://token.actions.githubusercontent.com --source-digest 320347356891aa1c24e0f2f9ce12719317e58bde --source-ref refs/heads/main --signer-digest 320347356891aa1c24e0f2f9ce12719317e58bde --deny-self-hosted-runners --digest-alg sha512 --format json
```

[GitHub CLI's verification reference](https://cli.github.com/manual/gh_attestation_verify)
describes the certificate, source, runner and bundle policies. The earlier
[content-inspection record](evidence/npm-content-inspection-3.46.2.json) is an
unchanged historical decode-only observation; this later result adds actual
signature and identity-policy verification.

This evidence covers the historical 3.46.2 payload and signed provenance.
No package dependencies, application runtime, MCP process, migration or
installed operator journey was installed or executed in this check. The
selected new release's protected-main checks, npm/image/installer publication,
installed matrices, vulnerability-response tabletop and independent
Engineering A- reassessment still require their own passing evidence.
