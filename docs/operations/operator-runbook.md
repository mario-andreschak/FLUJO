# Operator runbook: install, check, back up, upgrade and restore

This page walks you through running FLUJO for other people or as a service:
install a pinned version, check it is up, find a failed job, take a backup,
upgrade and restore. Every step has a command for Linux and macOS (bash) and
one for Windows (PowerShell 7.4 or newer). You need Node.js 22.23.4+ (within
22.x) or 24.22.1+ (within 24.x) with npm.

CI follows this page word for word on Linux and Windows before every release
(`scripts/operator-runbook.mjs`, see the end of this page). If a step here is
wrong or missing, that run fails, so these commands are known to work.

## 1. Choose your settings

Pick the version to install, the version you will upgrade to later, a folder
that only FLUJO uses for its data, a port and where backups go. Run this in
every terminal you use for FLUJO.

<!-- operator-step: choose -->
```bash
export FLUJO_VERSION=3.48.9
export FLUJO_NEW_VERSION=3.48.10
export FLUJO_DATA_DIR="$HOME/flujo-data"
export FLUJO_PORT=4200
export FLUJO_BACKUP="$HOME/flujo-backup.zip"
```

```powershell
$env:FLUJO_VERSION = '3.48.9'
$env:FLUJO_NEW_VERSION = '3.48.10'
$env:FLUJO_DATA_DIR = "$HOME\flujo-data"
$env:FLUJO_PORT = '4200'
$env:FLUJO_BACKUP = "$HOME\flujo-backup.zip"
```

Use exact version numbers, never `latest`, so you always know what runs. Keep
the data folder outside the place npm installs packages.

## 2. Install and start

This downloads the chosen version once and starts it. Leave it running: in its
own terminal, or under your service manager (systemd, a Windows service, a
scheduled task at startup).

<!-- operator-step: start -->
```bash
npx --yes "flujo-ai@$FLUJO_VERSION" --no-open --port "$FLUJO_PORT"
```

```powershell
npx --yes "flujo-ai@$env:FLUJO_VERSION" --no-open --port $env:FLUJO_PORT
```

## 3. Check that it is up

The first start can take a few minutes while npm downloads FLUJO. This waits
until FLUJO has finished starting, then shows the version that runs.

<!-- operator-step: check -->
```bash
until curl -fsS -o /dev/null "http://127.0.0.1:$FLUJO_PORT/api/init"; do sleep 5; done
curl -fsS "http://127.0.0.1:$FLUJO_PORT/api/update"
```

```powershell
do { try { $ready = (Invoke-RestMethod "http://127.0.0.1:$env:FLUJO_PORT/api/init").success } catch { $ready = $false; Start-Sleep 5 } } until ($ready)
(Invoke-RestMethod "http://127.0.0.1:$env:FLUJO_PORT/api/update").currentVersion
```

## 4. Find failed jobs

Scheduled and triggered flows are "jobs". This lists every job whose last run
failed, with the error it reported.

<!-- operator-step: diagnose -->
```bash
curl -fsS "http://127.0.0.1:$FLUJO_PORT/api/planned-executions" | node -e "
let text = '';
process.stdin.on('data', chunk => { text += chunk; }).on('end', () => {
  for (const { execution, lastRun } of JSON.parse(text).executions) {
    if (lastRun?.status === 'error') console.log(execution.name + ': ' + lastRun.error);
  }
});"
```

```powershell
(Invoke-RestMethod "http://127.0.0.1:$env:FLUJO_PORT/api/planned-executions").executions |
  Where-Object { $_.lastRun.status -eq 'error' } |
  ForEach-Object { "$($_.execution.name): $($_.lastRun.error)" }
```

A provider error such as 400, 401 or 429 means: check that job's model
connection (address, key, allowance) before you run it again. FLUJO does not
run a failed job again by itself.

## 5. Take a backup

This saves flows, conversations, the theme and the names of your settings to
one file. Setting values never go into a backup, because they can hold keys:
note down the ones you need elsewhere.

<!-- operator-step: back-up -->
```bash
curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"selections":["flows","chatHistory","settings","globalEnvVars"]}' \
  -o "$FLUJO_BACKUP" "http://127.0.0.1:$FLUJO_PORT/api/backup"
```

```powershell
Invoke-WebRequest "http://127.0.0.1:$env:FLUJO_PORT/api/backup" -Method Post -ContentType 'application/json' `
  -Body '{"selections":["flows","chatHistory","settings","globalEnvVars"]}' -OutFile $env:FLUJO_BACKUP
```

## 6. Stop

<!-- operator-step: stop -->
Press Ctrl+C in the terminal where FLUJO runs, or stop its service. Wait until
the command has ended before you upgrade.

## 7. Upgrade

Start the new version on the same data folder. FLUJO updates the data it finds
there and keeps it. Then run step 3 again: it must show the new version.

<!-- operator-step: upgrade -->
```bash
npx --yes "flujo-ai@$FLUJO_NEW_VERSION" --no-open --port "$FLUJO_PORT"
```

```powershell
npx --yes "flujo-ai@$env:FLUJO_NEW_VERSION" --no-open --port $env:FLUJO_PORT
```

To go back, stop FLUJO and start the old version the same way. A data folder
that a newer version already updated may not open in an older one; restore
your backup into a new, empty data folder instead.

## 8. Restore the backup

This brings flows, conversations and the theme back to what the backup holds.
Settings keep their current values; a setting that only the backup knows is
added without a value.

<!-- operator-step: restore -->
```bash
curl -fsS -F "file=@$FLUJO_BACKUP" -F 'selections=["flows","chatHistory","settings","globalEnvVars"]' \
  "http://127.0.0.1:$FLUJO_PORT/api/restore"
```

```powershell
curl.exe -fsS -F "file=@$env:FLUJO_BACKUP" -F 'selections=["flows","chatHistory","settings","globalEnvVars"]' "http://127.0.0.1:$env:FLUJO_PORT/api/restore"
if ($LASTEXITCODE) { throw "Restoring the backup failed (curl exit $LASTEXITCODE)." }
```

On Windows this uses `curl.exe`, which comes with Windows 10 (1803) and
Windows Server 2019 and newer: PowerShell's own `-Form` upload is not accepted
by FLUJO. The answer reports `"success": true` and, per part, how many records
came back.
When you are done, stop FLUJO as in step 6.

## How CI follows this page

`node scripts/operator-runbook.mjs --pack` plays the operator on a fresh
machine account: an empty home folder, an empty npm cache and an empty data
folder. It reads the steps above in order, runs the commands for its system
exactly as written (bash on Linux and macOS, PowerShell 7 on Windows) and
checks what each step promises:

| Step | What the run checks |
| --- | --- |
| Choose | It sets exactly the variables the other steps use |
| Install and start, Upgrade | FLUJO starts with its data in the chosen folder |
| Check | It ends, and shows the version that should run |
| Find failed jobs | It names a job whose model refused its request, with the error |
| Take a backup | The file holds the flows, conversations and theme, and no setting value |
| Stop | FLUJO ends and frees its port |
| Restore | Flows, conversations and theme are back after they were changed |

The release under test is offered to npm as the new version, from a local
stand-in registry that passes every other package through from npmjs.org. The
old version is the latest published one (the one before it when the release
under test has the same number). The failed job uses a local stand-in model;
no real provider is called. A missing step, a step out of order, a variable
that no step sets or a command that fails stops the run with the name of the
step.
