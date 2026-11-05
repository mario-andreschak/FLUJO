# Quiet installs

For an installation someone else looks after, put this in the instance's `.env`
file:

```text
FLUJO_MANAGED=1
```

That turns off usage reporting and update checks and notices. Ordinary installations
are not affected and keep their current defaults.

| Setting | Effect |
| --- | --- |
| `FLUJO_MANAGED=1` | Both of the below |
| `FLUJO_TELEMETRY=off` | No usage reporting, and the switches for it leave the Privacy settings page. A person using the app cannot turn it back on |
| `FLUJO_UPDATE_CHECK=off` | No update check and no notice. The in-app update button is refused. `flujo update` still works |

These are plain environment settings, so a provisioning tool can write them like any
other.

## What usage reporting sends

Default for ordinary installations: on, with a notice in the app the first time each
day and a switch under Settings > Privacy.

- **Where:** `https://registry.flujo.com.co/v1/telemetry/daily-active`, or
  `FLUJO_TELEMETRY_URL` if set.
- **When:** at most once per UTC day, and only when the app is opened in a browser.
  An instance nobody opens sends nothing, with or without this setting.
- **What:** a random ID made new each day, the date, the FLUJO version, the operating
  system family and how it was installed. Nothing about flows, prompts, models, keys,
  files or accounts.
- The Privacy page also asks the same address for today's overall count.

## What else leaves the machine

`FLUJO_MANAGED` does not change these, because each one is something the installation
is set up to do:

- Calls to the model providers and MCP servers you configure.
- `https://registry.flujo.com.co` for the MCP server catalogue and suggested servers,
  at startup and when browsing it. `FLUJO_REGISTRY_BASE_URL` points that elsewhere.
- npm, when an MCP server is installed or an npx-based one starts, and when
  `flujo update` fetches a version from npm.
- The Codex runtime's own update check, if that adapter is used.
  `FLUJO_CODEX_AUTO_UPDATE=0` turns it off.
- An update check against `origin` in a Git checkout, which the `FLUJO_UPDATE_CHECK`
  setting does cover.

If an installation must send nothing at all beyond what it was set up for, also block
outbound traffic at the network level. That is the only way to prove it.
