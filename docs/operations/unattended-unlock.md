# Starting a locked instance with nobody there

An instance with a custom encryption password stays locked after every start. Its
schedules and MCP servers wait until someone types the password. That is the right
default, and it does not change unless you opt in.

To start with nobody present, the instance needs the password from somewhere. The
question is where it can be kept without undoing the protection.

## Choose a way

| Way | Set up with | Who can read the secret | Best for |
| --- | --- | --- | --- |
| Windows, this user | `FLUJO_UNLOCK_SECRET_SOURCE=dpapi`, scope `user` | Programs running as this Windows user on this PC | `logon` start mode |
| Windows, this PC | `FLUJO_UNLOCK_SECRET_SOURCE=dpapi`, scope `machine` | Any program on this PC that can read the file. The file is the only barrier | `boot` start mode, which cannot use scope `user` |
| Environment | `FLUJO_UNLOCK_SECRET_SOURCE=env` | Whatever you use to provide it | Linux with systemd credentials or a secrets tool |
| Operator file | `FLUJO_ENCRYPTION_SECRET_FILE` | Whoever can read that file | Containers and fresh installs. Already exists; see [private encryption profiles](../security/private-encryption-profiles-v1.md) |

With any of these, someone who copies only the data directory or a backup of it
still cannot read your credentials, as long as the secret is kept off that copy.
None of them protects against a program already running as this user on this PC:
such a program could also read the instance's memory or wait for an unlock.

These choices are always refused, and the instance stays locked instead:

- a secret in a `.env` file, which sits next to the data it should protect
- a secret file inside the data directory
- a secret with no source selected, which is ignored and removed

## On Windows

Provide the password on standard input, so it never appears on a command line.
It must already be the password of this instance, or be set as its password first.

```powershell
Get-Content C:\secure\pw.txt | flujo unlock-secret set --name pilot --scope user
flujo unlock-secret check --name pilot
```

Then add to the `.env` file in the instance's data directory what the command
printed:

```text
FLUJO_UNLOCK_SECRET_SOURCE=dpapi
FLUJO_UNLOCK_SECRET_FILE=C:\Users\me\.flujo-service\pilot\unlock-secret.json
```

The `boot` start mode runs without your password, so Windows cannot open data
protected for your user, and `--scope user` then fails. Use `--scope machine` with
`boot`. Restrict the file to the instance's account, because at machine scope that
restriction is the protection.

Windows protects this data against the user's password. If an administrator resets
that password, scope `user` secrets may stop opening. The instance then stays
locked and waits for someone, and `flujo unlock-secret set` puts it right.

## On Linux

Provide `FLUJO_UNLOCK_SECRET` to the process from a protected source, for example
an `EnvironmentFile` readable only by root, or a secrets tool, and set
`FLUJO_UNLOCK_SECRET_SOURCE=env` in the same place.

## What happens at start

1. The launcher settles the secret from the chosen source.
2. The server takes it out of its environment straight away, so MCP servers and
   other child programs never receive it.
3. Each workspace with a password is unlocked before its schedules start. A
   workspace with a different password stays locked and waits for someone.
4. Schedules, MCP servers and waiting runs start the same way they do after someone
   types the password.

Anything going wrong (wrong password, source missing, Windows refusing) means only
that the instance stays locked and is still reachable. The log gets one fixed line
that says nothing about the secret. `flujo selftest` reports `locked`.

## Missed schedules

A schedule with catch-up on runs what it missed when FLUJO was off or locked. By
default that is one run, the first one it missed. Set `catchUpLimit` on the
schedule (up to 100, also in the schedule dialog) to run more of them, newest ones
first chosen and then run oldest to newest, one after the other. Worker mode stays at one.

If FLUJO stops partway through a catch-up, the rest are not run again. That is
deliberate: a repeat could do outside work twice.

## What has and has not been checked

See the pull request for what was run. Not checked: `boot` mode with scope `machine`
on a real restart, which needs administrator rights, and any Linux source on a real
machine.
