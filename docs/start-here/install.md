# Install and open FLUJO

Choose one installation below, then open [localhost:4200](http://localhost:4200). Keep the FLUJO server running while you use it.

## Windows

**[Download the Windows installer](https://github.com/mario-andreschak/FLUJO/releases/latest/download/flujo-setup.exe)** from the [latest release](https://github.com/mario-andreschak/FLUJO/releases/latest).

The installer sets up FLUJO and needed runtimes such as Git, Node.js, Python, uv and ripgrep. It downloads dependencies, so an internet connection and Windows App Installer (`winget`) are required. Check the release notes for the installer's version and channel.

Prefer PowerShell? Run:

```powershell
irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.ps1 | iex
```

This script follows the development branch by default. [Windows paths, updates and options](windows.md).

## Linux or macOS

```bash
curl -fsSL https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.sh | bash
```

The script installs prerequisites through your package manager, builds FLUJO, and registers the `flujo` command. It follows the development branch by default. [Linux and macOS options](unix.md).

## Already have Node.js?

Use **Node.js 22.17+ within 22.x, or 24.2+ within 24.x**, then run:

```bash
npx flujo-ai@latest
```

This starts the latest published npm release without a local build. Some connected tools still need Git, Python or uv. [Data location, ports and npm options](npm.md).

## Get your first result

1. Open **AI Setup → Connect AI** and connect a cloud provider, supported subscription login, or local Ollama model.
2. Use **Test model** on the saved model card. Saving alone does not check access or quota; the test may consume provider allowance.
3. Follow [the Website Builder guide](../journeys/website-builder.md), or start with [one AI-only conversation](../getting-started/README.md).

If port 4200 is already in use, open the existing FLUJO instance before starting another. For login or model errors, [check the connection first](using-flujo.md#when-something-goes-wrong).

## Other setups and maintenance

- [Build from source](source.md) or [run with Docker](docker.md).
- [Corporate proxy and certificate setup](proxy.md).
- [Network access and remote deployments](network.md).
- [Uninstall on Windows](uninstall.md). Back up your workspace first: uninstalling removes its data.

Read [privacy and costs](privacy.md) before connecting sensitive work. The default setup is for one trusted operator on localhost.

[Start here](README.md)
