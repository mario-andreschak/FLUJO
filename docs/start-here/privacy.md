# Your data, providers and costs

FLUJO is MIT-licensed software that runs on your computer. It does not include a model-provider plan or free access to connected services.

## What leaves your computer

Your workspace stores agents, model connections, conversations and settings locally. When you choose a cloud model, its provider receives the prompt, selected context and authentication needed for the request. Connected tools may send data to their own services. Using local Ollama can keep model inference on your computer; check the tools you enable too.

Cloud API calls, connection tests and scheduled runs may incur provider charges. Subscription connections use the account's model access and allowance. Local models need your own hardware. A fallback policy can send a request to another configured provider when the selected failure conditions occur; each provider's terms and charges apply.

## Protect stored credentials

Set a private encryption password in **Settings**. The public default password provides obfuscation, not a private vault. Older plaintext records require explicit repair; follow the [encryption and migration guide](../../src/utils/encryption/README.md).

Store keys in connection fields or **More → Settings → Global variables**, then bind them where needed. Do not put secrets in prompts, screenshots or issue reports.

Backups and portable-worker snapshots can contain credentials. Keep them private and use the [workspace transfer guide](../features/hot-clone-workspace.md) before moving them to another machine.

## Connected tools have permissions

Installing a GitHub server can run its installation and build scripts. Local tools execute with the FLUJO server's operating-system permissions. A remote connection sends requests to the configured service. Review the source and the tools you grant; optional tool approvals let you review actions but do not sandbox local programs.

Interactive MCP Apps have a separate browser sandbox. That browser boundary does not turn their server-side tools into isolated host processes. [Apps support and limits](../features/mcp/apps.md).

## Anonymous usage sharing

FLUJO sends one anonymous daily-active pulse by default. Its payload contains the app version, platform, install method, UTC date and an identifier that changes each day. It does not include flows, prompts, models, keys, filenames, account details or a permanent installation identifier.

A daily in-app notice discloses the check. Sharing and the notice can be controlled independently in **Settings → Privacy & Usage**. Operators can point `FLUJO_TELEMETRY_URL` at a compatible self-hosted collector.

## Keep the default local boundary

The default local profile has no owner login. Workspaces organize one operator's data; they do not provide separate user accounts or access control. Public/shared hosting is not an accepted deployment profile. Read [network access](network.md) and the [security policy](../../SECURITY.md) before exposing an installation.

[Install](install.md) · [Capabilities](capabilities.md) · [Start here](README.md)
