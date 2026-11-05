# Updating with nobody there

```sh
flujo update --name pilot --to 3.48.6
flujo update --name pilot --to 3.48.6 --package D:\flujo-ai-3.48.6.tgz --integrity sha512-...
```

The instance must have been set up with `flujo service install`.

## What happens

1. **Checks, while FLUJO keeps running.** The time window, whether runs are in
   progress, the package's hash, that it really is `flujo-ai` at that exact version,
   and that there is room for a data copy. Any problem here changes nothing.
2. **Installs the new version beside the old one**, in `<root>/versions/<version>`.
3. **Stops FLUJO and copies the whole data directory** to `<root>/backups`. The copy's
   file count and size are checked against the original.
4. **Switches and starts.** Then it runs the [self-test](self-test.md), for up to 5
   minutes by default, since a data migration can take a while.
5. **If the self-test passes**, it removes older versions and copies, keeping two of
   each.
6. **If it fails**, it stops the new version, puts back the data copy, switches back,
   starts the old version, tests it, and removes the failed version.

If the power goes or the process is killed at any point, the next start of the
instance reads `<root>/update-journal.json`. Before the switch nothing has changed, so
it simply carries on. After the switch it goes back, exactly as in step 6.

The outcome of the last update is in `<root>/last-update.json`.

| Exit code | Meaning |
| --- | --- |
| `0` | Updated, or already on that version |
| `1` | Refused or failed with nothing changed |
| `3` | The new version failed. Back on the old version, with its data, and working |
| `4` | Outside the time window |
| `5` | Runs are in progress, or that could not be seen |
| `6` | Going back also failed. **This one needs a person** |

## Options

| Option | Meaning |
| --- | --- |
| `--package <file>` | Install from a local file. Requires `--integrity` or `--sha256`. From npm, the hash npm publishes is checked instead, and either option adds a further check |
| `--offline` | Do not contact npm. Everything `flujo-ai` depends on must already be in the npm cache |
| `--window 01:00-05:00` | Update only in this local time span, which may cross midnight. Or set `FLUJO_UPDATE_WINDOW` in the instance's `.env`. `--now` ignores it |
| `--allow-active-runs` | Update even if runs are in progress. On Windows they are ended by force |
| `--strict` | Also go back if a model or MCP server cannot be reached |
| `--selftest-timeout <seconds>` | How long to wait for a usable new version |

Waiting for a tool approval does not count as in progress, since those runs survive a
restart. If an owner token is needed to look, it comes from `FLUJO_OPERATIONS_TOKEN`;
without it the update refuses rather than assumes nothing is running.

An instance stopped on purpose is refused, so an update never starts it against
someone's wishes. A locked instance that was locked before the update counts as fine
after it, because a person has to unlock it anyway, unless
[unattended unlock](unattended-unlock.md) is set up. In that case the deeper checks
ran too.

## Limits

- **Going back loses what changed since the copy.** That window is short, since
  FLUJO is stopped for the copy, but a schedule that ran on the new version during its
  self-test has its record removed. Its outside effects, such as a sent message, are
  not undone.
- **Disk.** Each copy is the size of the data, and two are kept. An update is refused
  without room for one more, plus 512 MiB.
- **Node.** The update does not change Node. A version that needs a newer Node fails
  its self-test and goes back.
- **Not checked:** an update that includes a real data migration, an update on a real
  restart in `boot` mode, and an update under antivirus, which can hold files open and
  slow the swap down. The swap retries for 30 seconds.
