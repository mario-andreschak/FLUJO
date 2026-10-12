# Uninstall FLUJO on Windows

To remove FLUJO, run the uninstaller:

```powershell
irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/uninstall.ps1 | iex
```

or, from inside your install folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
```

It asks, per prerequisite (Git, Node.js, Python, uv, ripgrep, and optional Ollama), whether
to remove it — defaulting to **yes** for ones FLUJO installed and **no** for ones
that were already on your system — then removes the `flujo` command and the FLUJO
folder. These ownership decisions come from
`%LOCALAPPDATA%\FLUJO-cli\install-manifest.json`; without a readable manifest,
all detected prerequisites default to **keep**. The graphical bootstrapper is
intentionally not registered in Windows Apps, so this direct PowerShell command
is the supported uninstall entry point.

> ⚠️ **This permanently deletes your data.** All workspace data—including flows,
> encrypted API keys, MCP server configs, chat history, user files and runtime
> artifacts—lives below `<data root>\workspaces\<workspace>\` and is removed with
> the installation/data folder. Use FLUJO's built-in backup/export first if you
> want to keep it.

Installs created before this feature have no manifest; the uninstaller then defaults every
prerequisite to **keep** (it can't tell which FLUJO installed). Re-running the installer
once writes the manifest for future uninstalls. See
[`scripts/uninstall.ps1`](../../scripts/uninstall.ps1) for details.

[Back to installation](install.md) · [Start here](README.md)
