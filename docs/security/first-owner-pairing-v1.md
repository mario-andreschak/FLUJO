# First-owner local pairing

Owner identity and encryption remain separate boundaries. Provision a first-owner capability using the installed `scripts/owner-bootstrap.mjs` with a **new absolute private directory outside FLUJO data** and an owner id:

```text
node scripts/owner-bootstrap.mjs /private/flujo-owner owner
```

Windows accepts an absolute native path; the operator must independently restrict that directory to the owning account with ACLs. POSIX provisioning creates 0700/0600 paths. The command never reuses an existing directory and prints only configuration paths and expiry, never secret bytes. `pairing-token` contains the randomly generated 256-bit capability; `bootstrap.json` contains only its digest and a 15-minute grant. The command does not create the final owner policy.

Set `FLUJO_OWNER_AUTH_FILE` to the reported `policyFile`, `FLUJO_OWNER_BOOTSTRAP_FILE` to `bootstrapFile`, `FLUJO_OWNER_BROWSER_ORIGIN` to the exact literal loopback browser origin (for example `http://localhost:4200`), and `FLUJO_EXPOSURE_MODE=localhost`. Start FLUJO and open `/owner/login`. Its first-owner form accepts the private local pairing capability and explicit enrollment confirmation. No token belongs in a URL, browser storage, migration report, log or audit entry.

While pairing is pending, the selected missing owner policy keeps protected API access closed. Only the exact GET/POST `/api/owner/bootstrap` endpoint can pass the owner proxy seam, and its handler independently validates capability availability, literal loopback configuration, exact Host/URL/Origin and bounded body. Forwarded headers confer no authority. Worker, network and public pairing are refused. Unconfigured legacy localhost behavior is unchanged; bootstrap does not authorize anonymous broader exposure.

POST enrolls the capability's fixed owner identity and a newly generated admin/secret credential in an exclusive 0600 policy file. Caller-selected identities/scopes are rejected. An atomic no-replace link elects a single first owner across OS processes. Any existing file, including corrupt or empty authority, disables pairing and is preserved. Successful enrollment immediately disables replay even if the unused short-lived capability files remain. Pairing files are not workspace data or transferable snapshot material; delete them after saving the new owner credential, or let the grant expire. No automated overwrite/reset is provided.

The new owner bearer is returned once, without storage in the browser. The existing session implementation generates an independent HttpOnly/SameSite cookie and durable hashed session record. Saving the bearer privately is required before navigating away; it expires after one year and remains subject to policy revocation/replacement. Execution/client grants remain separately scoped. If session creation fails after policy commit, the response still returns the new bearer so normal sign-in can recover. If cancellation, process failure or response loss occurs after commit, do not assume enrollment rolled back: preserve the owner policy and use the existing owner-controlled offline replacement recovery contract. No failure automatically erases committed authority.

Source tests cover real CLI output/files, actual route/session admission, expiry/revocation/scope/Origin denials, retained existing authority, and two OS processes electing one owner. They do not establish Windows ACL enforcement, installed-artifact qualification, human approval or an external reassessment.
