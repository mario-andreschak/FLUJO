# Windows installer details

On a fresh Windows machine you can install everything (Git, Node.js, Python, uv, ripgrep),
clone FLUJO, build it, and optionally start it with a single PowerShell command:

```powershell
irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.ps1 | iex
```

By default FLUJO is installed into `%LOCALAPPDATA%\FLUJO`. To customise the install
without the interactive prompt, set environment variables first, e.g.:

```powershell
$env:FLUJO_DIR = "D:\Apps\FLUJO"; $env:FLUJO_START = "1"; irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.ps1 | iex
```

See [`scripts/install.ps1`](../../scripts/install.ps1) for all options.

Prefer a graphical installer? Download `flujo-setup.exe` from the
[latest release](https://github.com/mario-andreschak/FLUJO/releases/latest) — it's a
wizard around the same `install.ps1` script above (see
[`installer/flujo-setup.iss`](../../installer/flujo-setup.iss)).

The Windows installer is a networked bootstrapper, not an offline file-copy
package. It requires Windows App Installer (`winget`) and access to GitHub, the
winget catalog, npm, and Python package sources. Missing Git, Node.js, Python,
uv, and ripgrep are installed through winget; Ollama is optional. The installer also
installs the Claude Code CLI used by the optional Claude Subscription provider.
Installer builds from the current source pin versioned Windows releases to their
tag and commit. The one-line scripts default to the `main` development channel;
their installed revision and channel are recorded in the installation manifest.
Older released installers may still follow `main`; check their release notes.

Reruns require an official FLUJO checkout with a clean working tree and no local
commits that the update would discard. Dirty, diverged, unrelated, or wrong-branch
targets stop with recovery guidance. Commit or back up your work before retrying.
Development updates are fast-forward only. A stable detached-tag install is
upgraded with a newer versioned installer; the in-app updater does not switch it
to `main`.

[Back to installation](install.md) · [Start here](README.md)
