# Corporate proxies and certificates

Both one-line installers and `flujo-setup.exe` are network bootstrappers. They require Node.js 22.19+ within 22.x, or 24.2+ within 24.x and may contact GitHub/`raw.githubusercontent.com`, the OS package manager, the npm registry, and Patchright 1.61.1's managed-browser mirrors at `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`. Ask your network administrator to allow those services or provide an approved mirror.

Prefer your organization's approved OS trust configuration. If that is unavailable, set an explicit proxy and readable PEM CA bundle for the installer session. The `FLUJO_*` aliases are mapped only into installer child processes; they do not change global npm/Git configuration, the certificate store, or persistent environment variables.

Windows PowerShell:

```powershell
$env:FLUJO_HTTPS_PROXY = "https://proxy-user:proxy-password@proxy.example.test:8443"
$env:FLUJO_NO_PROXY = "localhost,127.0.0.1,.example.test"
$env:FLUJO_EXTRA_CA_CERTS = "C:\Certificates\corporate-root.pem"
$env:FLUJO_PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT = "120000"
irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.ps1 | iex
```

Linux/macOS:

```bash
export FLUJO_HTTPS_PROXY='https://proxy-user:proxy-password@proxy.example.test:8443'
export FLUJO_NO_PROXY='localhost,127.0.0.1,.example.test'
export FLUJO_EXTRA_CA_CERTS='/path/to/corporate-root.pem'
export FLUJO_PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT='120000'
curl -fsSL https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.sh | bash
```

The initial `irm`/`curl` request must itself be able to reach GitHub, so configure the shell or OS proxy first if required. Optional `FLUJO_HTTP_PROXY`, `FLUJO_PLAYWRIGHT_DOWNLOAD_HOST`, and standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `npm_config_cafile`, `PLAYWRIGHT_DOWNLOAD_HOST`, and `PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT` values are also honored. Proxy URLs may contain credentials; do not paste them into issue reports. Installer logs redact known secret forms and are saved under the FLUJO CLI metadata directory.

Managed Chromium is installed as the named `patchright-chromium` stage. After correcting a proxy, CA, DNS, or timeout problem, retry only that version-matched browser download from the FLUJO directory:

```bash
node mcp-servers/browser/scripts/install-browser.mjs
```

On Ubuntu/Debian, the Unix installer also installs Chromium's Linux libraries
and fonts in the `patchright-system-dependencies` stage, then checks a real
headless browser launch in `patchright-verification`. After updating FLUJO, retry
a failed browser setup from the FLUJO directory:

```bash
sudo "$(command -v node)" mcp-servers/browser/scripts/install-browser.mjs --install-deps
node mcp-servers/browser/scripts/install-browser.mjs --verify
```

The dependency step requires root (omit `sudo` when already root); browser
verification runs as your regular user. Production builds use `tsconfig.build.json`
to check application code; `npm run typecheck` still checks the full test suite.

Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`, `npm strict-ssl=false`, or another TLS-verification bypass. The installers ignore an inherited Node TLS bypass and direct you to secure proxy/CA configuration instead.

[Back to installation](install.md) · [Start here](README.md)
