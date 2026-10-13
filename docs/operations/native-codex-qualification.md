# Native Codex qualification

Run this in a Source developer checkout with its local test dependencies.
`npm run qualify:live-codex` executes the three account-backed Source checks
serially: the owned app-server and interruption, restrictive catalogue with the
thread-bound MCP bridge, and a saved Persona Original with a genuine lease.
It requires the exact selected test to execute and pass. A skipped test, missing
receipt, failed process or wrong model/effort fails the command.

Provide these absolute paths in the environment, all outside the checkout:

| Variable | Existing private resource |
| --- | --- |
| `FLUJO_LIVE_CODEX_PATH` | The qualified Codex executable |
| `FLUJO_LIVE_CODEX_HOME` | The private app-server profile, including its workspace |
| `CODEX_HOME` | The existing host profile used by Source native qualification |
| `FLUJO_LIVE_CODEX_CATALOG` | The existing model catalogue |
| `FLUJO_LIVE_CODEX_OUTPUT_DIR` | An existing private directory for evidence |

The runner reads existing profiles in place. It does not sign in, copy account
files into Workers, or grant a new provider route. It gives each check a separate
receipt and retains its Jest result and logs in a fresh private directory. The
test sandbox and conversation logs also use that private directory. Failed runs
retain their evidence. When a completed built-in denial probe fails its exact
response requirement, Source records a private refusal, closes the actual child,
and still refuses admission; the live Original test preserves that refusal
before removing its sandbox.

Ordinary CI has no authorized account and leaves these provider checks opt-in.
Their omission is not live qualification. This command must pass separately on
the selected runtime before claiming these three checks passed. Its receipts
cannot mint a Source capability or establish Worker ownership, image deployment,
tool gateway, child Original inheritance, multiworker execution or swarm work.
Provider usage is separate from billed spend, which remains unknown unless
independently supplied by the provider.

The qualification path still admits the tested 0.157.1 binary. Current main's
ordinary SDK/runtime stays at its own locked version. The explicit
`FLUJO_LIVE_CODEX_PATH` is used for the restricted catalog qualification as well
as the app-server check; a different bundled version cannot stand in for it.
An admitted Worker can use its trusted adapter's separately pinned restrictive
profile. Its binary and catalog are reread before Source's own qualification.
Persona Originals keep their existing Source host and owned-thread behavior.

Qualification and Original execution share the bounded startup projection for
restricted capabilities, the verified catalog and neutral project trust. These
controls are set before app-server initialization. Bridge URLs, headers and
instructions remain in the private thread-start message. Persona API-key auth
is preserved; the admitted Worker path remains keyless. Changing this projection
changes the qualification policy digest, so earlier cached qualification cannot
stand in for the updated launch.
