# Linux and macOS installer details

The installer prepares the prerequisites (Git, Node.js, Python,
uv, ripgrep) via your package manager (or Homebrew on macOS), clones FLUJO, builds it, and
registers the `flujo` command:

```bash
curl -fsSL https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.sh | bash
```

By default FLUJO is installed into `~/FLUJO`. To customise without the
interactive prompts, set environment variables first, e.g.:

```bash
curl -fsSL https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.sh | FLUJO_DIR="$HOME/apps/FLUJO" FLUJO_START=1 bash
```

See [`scripts/install.sh`](../../scripts/install.sh) for all options.

[Back to installation](install.md) · [Start here](README.md)
