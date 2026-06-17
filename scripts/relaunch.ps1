<#
.SYNOPSIS
    Restarts the FLUJO production server after an in-app update.

.DESCRIPTION
    Launched detached by the /api/update endpoint after a successful
    git pull + npm install + npm run build. It waits for the old server to
    release the port, starts the freshly built server with `npm start`, then
    opens the browser once it is listening again.
#>
param(
    [string]$Dir = (Get-Location).Path,
    [int]$Port   = 4200
)

$ErrorActionPreference = 'SilentlyContinue'
Set-Location $Dir

function Test-PortListening([int]$p) {
    return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

# Wait (up to 60s) for the old server to exit and free the port.
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and (Test-PortListening $Port)) {
    Start-Sleep -Seconds 1
}

# Start the rebuilt server in its own window so it survives this script.
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm start' -WorkingDirectory $Dir

# Wait (up to 120s) for it to come up, then reopen the browser.
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline -and -not (Test-PortListening $Port)) {
    Start-Sleep -Seconds 2
}
Start-Process "http://localhost:$Port"
