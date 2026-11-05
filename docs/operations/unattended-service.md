# Keeping FLUJO running with nobody there

`flujo service` sets up one named instance so the operating system starts it and
keeps it running: its own data directory, its own port, no browser window.

```sh
flujo service install --name pilot --data-dir "C:\FLUJO\pilot\data" --port 4400
flujo service status --name pilot
flujo service stop --name pilot
flujo service start --name pilot
flujo service uninstall --name pilot
```

Add `--json` to any of these for output a program can read. `status` exits `3` if
the instance is not set up. `uninstall` never deletes the data directory.

## What happens on Windows

FLUJO uses Task Scheduler, not a Windows service. A Windows service would need an
extra wrapper program and usually runs as SYSTEM. A task runs as the ordinary user
who set it up, with no raised rights.

There are three start modes. `--mode auto`, the default, uses the best one Windows
allows and reports which one it got:

| Mode | When it starts | What it needs | Limits |
| --- | --- | --- | --- |
| `boot` | When the PC starts, with nobody logged in | Run the install once as administrator | Runs without your password, so Windows gives it no network shares and no data protected for your user alone. See [Starting a locked instance](unattended-unlock.md) |
| `logon` | When that user logs on | Nothing special on most PCs | Does not run until someone logs on |
| `timer` | Within 5 minutes of that user logging on | Nothing | Used only when Windows refuses `logon` |

Asking for `--mode boot` by name fails with an explanation if Windows refuses it,
rather than quietly giving you something less. No password is stored in any mode.

## What keeps it running

Three layers, each covering the one above it failing:

1. FLUJO crashes or stops answering: the **supervisor** (`flujo service run`)
   restarts it. It waits 1, 2, 5, 15, 30, then 60 seconds between tries and never
   gives up. A run of 10 minutes or more clears the delay.
2. The supervisor itself dies: the **operating system** starts it again. On
   Windows the task re-checks every 5 minutes; on Linux systemd restarts it
   within 5 seconds. The new supervisor first stops whatever the old one left
   running, so the port is free again.
3. The PC restarts: the autostart entry starts everything again.

Stopping on purpose is remembered. After `flujo service stop` the instance stays
stopped, through restarts of the PC too, until `flujo service start`.

Before stopping a leftover process the supervisor checks it really belongs to this
instance, because process numbers get reused. If some other program holds the
port, the supervisor leaves it alone, writes that to the log, and tries again.

On Windows, stopping FLUJO is always forced: Windows has no way to ask another
program to close down in an orderly way. Files are written so that an interrupted
write leaves the old or the new content, and a run in progress at that moment ends
the same way it would in a power cut. `flujo update` refuses to start during a run
for this reason.

## Settings

Put them in the `.env` file in the instance's data directory. The named data
directory and port always win over what the file says.

| Setting | Default | Meaning |
| --- | --- | --- |
| `FLUJO_LOG_MAX_BYTES` | 20971520 (20 MiB) | Size of one log file. Minimum 64 KiB. |
| `FLUJO_LOG_MAX_FILES` | 3 | Older log files kept. `0` keeps none. |
| `FLUJO_SERVICE_HANG_RESTART_MS` | 600000 (10 minutes) | Restart FLUJO if it has not answered for this long. `0` turns this off. |
| `FLUJO_SERVICE_LIVENESS_INTERVAL_MS` | 60000 | How often to check that it answers. |
| `FLUJO_SERVICE_ROOT` | `~/.flujo-service` | Parent folder for the instance folders described below. |

The hang check only asks for the site icon, which needs no login and no storage.
It therefore does not restart an instance that is locked or in the middle of a
long data migration.

## Where things live

`<root>` is `~/.flujo-service/<name>` unless you set `--root`. It must be outside
the data directory, so logs and old versions stay out of data backups.

| Path | What it is |
| --- | --- |
| `<root>/launch.mjs` | Stays in place, so the autostart entry never needs changing after an update |
| `<root>/current.json` | Which package version runs, and the one before it |
| `<root>/logs/flujo.log` | Everything FLUJO prints, plus the supervisor's notes |
| `<root>/state.json` | What the supervisor is doing, restarts, last exit |
| `<root>/stop-request` | Present while stopped on purpose |

Each instance also takes a second port for its MCP Apps sandbox. Unless
`FLUJO_MCP_APP_SANDBOX_PORT` is set, that is the instance's port plus one, so leave
a gap between instances on one PC.

## On Linux

As an ordinary user, `install` writes a user unit and turns on lingering, which
starts it at boot with nobody logged in. If lingering cannot be turned on, the
result says so and reports mode `logon`. As root it writes a system unit and
requires `--run-as <user>`, because FLUJO does not run as root.

## What has and has not been checked

Checked for real on Windows 10 Pro without administrator rights: creating, starting,
reading and removing the task, a crash and restart, a killed supervisor, and
stopping on purpose. See the pull request for exactly what was run.

Not checked:

- `boot` mode on a real restart. It needs administrator rights, which the test
  machine's session did not have. Its task definition is covered by tests only.
- A fresh Windows PC, a domain-joined PC, or a PC with a strict group policy. A
  policy can forbid a task, or forbid the `boot` mode's way of logging on.
- Antivirus. Node started from a task can be flagged by some products. Nothing
  here is code-signed.
- Linux on a real machine. The unit text and the order of commands are covered by
  tests against a stand-in; systemd itself has not run this unit.
