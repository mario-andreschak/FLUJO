# Self-test

`flujo selftest` asks a running instance whether it is really usable.

```sh
flujo selftest --port 4400
flujo selftest --name pilot --json
```

| Exit code | Meaning |
| --- | --- |
| `0` | Usable |
| `1` | Answered, and not usable: locked, needs a login, or a check failed |
| `2` | No answer |

It calls no model, starts no MCP server and runs no flow, so it costs nothing and
changes nothing beyond one temporary file. It prints no key, header or raw error.
Addresses are reduced to their host name, because a stored address can hold a key.

| Check | What it does | Fails the test? |
| --- | --- | --- |
| Storage | Writes a temporary file in the workspace, reads it back, removes it | Yes |
| Flows | Loads them | Yes |
| Models | Reads the list, then tries each host once, with no credentials. Any answer counts, even "not allowed" | Only if the list cannot be read, or with `--strict` if a host is unreachable |
| MCP servers | Reads the list and what each server is doing. Tries remote hosts as above. Does not start local ones, so one that has not been needed yet shows `state-cold` | Only if the list cannot be read, or with `--strict` |
| Schedules | Reports if paused or not started | No, a warning |

`--no-network` skips the host tries. `--workspace <name>` picks another workspace; the
default is the default workspace.

A login token, if this instance has an owner policy, comes from
`FLUJO_OPERATIONS_TOKEN`, as for `operations-inspect`. It needs `control:admin` and
`secrets:read`.

The same report is at `GET /api/operations/selftest?workspace=<name>`, with
`network=0` to skip the host tries. It follows the same access rules as
`GET /api/operations/status`.

A model that is reachable can still have a wrong key or no credit. Finding that out
would take a real, possibly paid, call, so this test does not.
