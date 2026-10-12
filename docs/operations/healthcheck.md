# Authenticated readiness probes

`node scripts/healthcheck.mjs` exits `0` only when its expected API is ready;
otherwise it exits `1`. It prints no credentials, response bodies or diagnostic
errors. The official image invokes this script through Docker's
[HEALTHCHECK instruction](https://docs.docker.com/reference/dockerfile/#healthcheck).

For an installation with owner authentication, supply `FLUJO_HEALTHCHECK_TOKEN`
to the probe through the deployment's protected environment configuration. This
must be a current credential issued by the installation's owner policy with both
`control:admin` and `secrets:read`, the existing capabilities required by
`GET /api/cwd`. A separate least-privilege readiness scope is not implemented.
Use a separately provisioned credential, protect it as an administrative secret,
and coordinate expiry, rotation and revocation with the probe configuration. Do
not put a token in the command line, URL, image build arguments or source files.
The probe does not issue credentials or bypass owner authentication.

The normal probe requires successful JSON with `success: true`. A fresh or
encryption-locked workspace is not ready until its encryption is initialized or
unlocked through the supported owner journey. A listening server can therefore
be unready because of locked storage, unavailable workspace layout, missing or
expired probe authority, or a failed request. This is a readiness observation,
not a diagnosis or a reason to automatically restart or erase storage.

Worker mode (`FLUJO_WORKER_MODE=1`) continues to use only
`FLUJO_SNAPSHOT_CONTROL_TOKEN` and `/api/worker/status`; it requires `mode: worker`
and `state: ready`. An owner health token cannot substitute for worker authority.
An installation without an owner policy can retain the anonymous normal probe.

`FLUJO_PORT` selects the numeric loopback port. If it is absent, the probe uses
`4200`; an explicitly empty, malformed or out-of-range port fails without making
a request. Configure the actual server's startup port to match: setting this
variable alone does not override an explicit launcher `-p` argument. Redirects
are refused, including redirects to login pages, and each request has a four
second deadline. Keep the supervisor's probe timeout longer than that deadline.

Focused local checks from a pinned source checkout:

```sh
node --test scripts/healthcheck.test.mjs
node scripts/smoke-healthcheck.mjs
```

The smoke requires an existing production build and installed dependencies. It
starts a real built HTTP server on a fresh ephemeral loopback port with its own
private operator and empty data, initializes user encryption with a passphrase
kept in memory, proves pre-unlock refusal and authenticated
readiness, exercises missing/wrong/insufficient/revoked/expired authority, and
stops the owned server gracefully before removing its private data. It does not
prove an official container image, supervisor restart policy or deployment
acceptance for issue #570. An optional application-directory argument can reuse
an unchanged qualified build. For an application directory that predates this
fix, add `--expect-previous-failure` to also check that its old probe fails under
the same owner policy.
