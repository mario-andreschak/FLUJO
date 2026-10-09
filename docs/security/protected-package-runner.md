# Protected local npx execution

The `trusted-host` policy supports `runtime: "npx"` for an already materialized,
exact local npm package closure. It runs genuine npm's `npx-cli.js` through the
reviewed absolute Node executable. It does not replace npx with the package's
Node entry point, install missing packages, or authorize imported configurations.
This is permission to run reviewed code as the owner account. Private HOME and
working directories route persistence; they are not an OS isolation boundary.

Prepare the complete npm source and package dependency tree under one managed
workspace `mcp-servers` source root. Materialize regular files, including binary
shims, instead of dependency links. The npm entry must be its `bin/npx-cli.js`.
The installation project and its `node_modules` belong inside that source root.
Include a regular copy of the intended shell and two empty files named
`runner-user.npmrc` and `runner-global.npmrc`. The installation project's `.npmrc`
must be absent or empty. Preparation is separate from runtime consent: inspect
the prepared bytes and their provenance before requesting host access.

Configure `command` as the absolute Node executable and `args` as
`["-y", "package-name@1.2.3", ...packageArguments]`. A scoped package name is
supported. Declare the policy's `entryPoint`, `sourceRoot`, source and executable
digests, and this `packageRunner` object:

```json
{
  "packageName": "package-name",
  "packageVersion": "1.2.3",
  "npmVersion": "10.9.2",
  "packageDirectory": "/absolute/managed/source/project",
  "binaryName": "package-name",
  "shell": "/absolute/managed/source/sh",
  "shellDigest": "<SHA-256 of the materialized shell>"
}
```

`binaryName` must match npm's actual default-bin selection, including its
multiple-bin rules. Set PATH to exactly the installation project's
`node_modules/.bin` followed by the reviewed Node executable's directory, using
the platform path delimiter. Declare an absolute `NPM_CONFIG_CACHE`. On Windows,
declare `SystemRoot`, `ComSpec` as the reviewed shell, and `PATHEXT` as
`.COM;.EXE;.BAT;.CMD`. Other `NPM_CONFIG_*` values and loader injection variables
are refused. Include every configured environment name in `environmentNames`.

For isolated runtime-home mode, the working directory is the workspace's
`userdata/mcp-runtime/<first 24 hex characters of SHA-256(server name)>/cwd`.
It is outside the source root. HOME, profile, config, cache and temporary roots
use the sibling private `home` tree. The review proposal includes these effective
values in its consent commitment. Runtime resolves the installation-wide
`FLUJO_MCP_RUNTIME_HOME_ISOLATION` override first, then the server setting, then
the workspace preference, then host mode. A grant for the other effective mode
is refused before launch; a server setting cannot override the global setting.

Review the configured server through
`GET /api/mcp/servers/<name>/host-consent?runtimeHome=isolated` (or `host`), using
the installation's private owner bearer and selected workspace. Inspect the
returned package revision, source, cwd, capabilities and `revision.launchArgs`.
Approve that exact `policyDigest` using POST to the same endpoint with
`runtimeHome`, `reviewedDigest` and a future `expiresAt` within 30 days. The
existing owner approval transaction rechecks the proposal, private authority
and configuration before publishing its separately protected ledger grant.
DELETE revokes it durably. Preview creates no execution grant.

Launch supplies explicit npm prefix, user/global configuration, shell and cache
arguments, offline resolution, disabled installation scripts, audit, funding,
update notification and workspace discovery. The complete npm and dependency
bytes, shims, Node, shell, arguments, environment, cwd, requested capabilities,
workspace and server are bound to consent. Changed or missing local packages
require a new review; there is no registry fallback or inherited floating consent.

npm prepends the cwd and every ancestor's `node_modules/.bin` ahead of PATH.
Those directories must be absent and are checked again immediately before
starting the transport. An injected ancestor binary refuses launch. By contrast,
explicit prefix and user/global configuration arguments prevent npm from loading
a cwd/ancestor `.npmrc`; those unrelated files are not read. Fresh source and
private authority checks also run before tool dispatch and after process startup.
These checks retain the existing host-consent limitations concerning concurrent
modification by code already running as the same OS account.
