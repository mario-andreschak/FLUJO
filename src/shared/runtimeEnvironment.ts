export type RuntimeEnvironmentCategory =
  | 'runtime'
  | 'performance'
  | 'migration'
  | 'mcpApps'
  | 'access'
  | 'bash'
  | 'browser'
  | 'integration';

export interface RuntimeEnvironmentDefinition {
  name: string;
  category: RuntimeEnvironmentCategory;
  description: string;
  sensitive?: boolean;
  internal?: boolean;
}

function definitions(
  category: RuntimeEnvironmentCategory,
  entries: Record<string, string>,
): RuntimeEnvironmentDefinition[] {
  return Object.entries(entries).map(([name, description]) => ({ name, category, description }));
}

/**
 * Operator-owned environment accepted by the FLUJO launcher/server or explicitly
 * forwarded to a bundled MCP process. Process-boundary outputs (FLUJO_WORKSPACE,
 * FLUJO_CAPTURE_*, runtime registration capabilities, etc.) are intentionally not
 * editable: FLUJO overwrites them and presenting them as settings would be unsafe.
 */
export const RUNTIME_ENVIRONMENT_DEFINITIONS: RuntimeEnvironmentDefinition[] = [
  ...definitions('runtime', {
    FLUJO_PORT: 'Main HTTP port (default 4200).',
    FLUJO_DATA_DIR: 'Installation data root. Changing it also changes where this settings file is read from.',
    FLUJO_APP_ROOT: 'Application/package root. Normally assigned by the launcher.',
    FLUJO_BASE_URL: 'Canonical URL used by FLUJO and bundled MCP clients.',
    FLUJO_BROWSER_URL: 'URL opened after startup; falls back to FLUJO_BASE_URL.',
    FLUJO_EXPOSURE_MODE: 'Listener mode: localhost, network, or public.',
    FLUJO_EXTRA_LOCAL_HOSTS: 'Legacy comma-separated hostnames treated as local.',
    FLUJO_CONTAINER: 'Marks the installation as container-managed when nonempty.',
    FLUJO_NPM: 'Marks the installation as npm-managed when nonempty.',
    FLUJO_OLLAMA_URL: 'Ollama endpoint (default http://localhost:11434).',
    FLUJO_OLLAMA: 'Advertise local-model support: 1, true, or yes.',
    FLUJO_REGISTRY_BASE_URL: 'Override the FLUJO package-registry base URL.',
    FLUJO_TELEMETRY_URL: 'Override the anonymous telemetry collector URL.',
    FLUJO_SNAPSHOTS: 'Set to 0, false, or off to forcibly disable snapshots.',
    FLUJO_SYSTEM_SCREENSHOT_ENABLED: 'Enable the host screenshot tool with 1, true, yes, or on.',
    FLUJO_EXTRA_CA_CERTS: 'Path to an additional PEM CA bundle.',
  }),
  ...definitions('performance', {
    FLUJO_CONVERSATION_CACHE_TTL_MS: 'Conversation cache TTL in milliseconds (default 1800000).',
    FLUJO_CONVERSATION_CACHE_MAX_ENTRIES: 'Maximum cached conversations (default 200).',
    FLUJO_CONVERSATION_CACHE_MAX_BYTES: 'Approximate conversation cache byte budget (default 67108864).',
    FLUJO_MCP_IDLE_TTL_MS: 'Warm MCP server idle TTL in milliseconds (default 600000).',
    FLUJO_MCP_MAX_WARM_SERVERS: 'Maximum simultaneously warm MCP servers (default 8).',
    FLUJO_MCP_BOOT_CONCURRENCY: 'MCP startup concurrency (default 2).',
    FLUJO_MCP_LAZY_START: 'Use lazy MCP startup when truthy.',
    FLUJO_GIT_STREAM_TIMEOUT_MS: 'Git stream timeout in milliseconds (default 900000; minimum 60000).',
    FLUJO_GITHUB_INSTALL_TIMEOUT_MS: 'GitHub install timeout in milliseconds (default 900000; minimum 60000).',
  }),
  ...definitions('migration', {
    FLUJO_MIGRATION_UI: 'Migration UI: plain, tty, compact, or landscape.',
    FLUJO_MIGRATION_ASCII: 'Force compact ASCII migration output.',
    FLUJO_MIGRATION_VERBOSE: 'Set to 1 to show migration output during tests.',
  }),
  ...definitions('mcpApps', {
    FLUJO_MCP_APP_SANDBOX_PORT: 'MCP Apps sandbox listener port (default 4201).',
    FLUJO_MCP_APP_SANDBOX_HOST: 'Explicit MCP Apps sandbox bind address.',
    FLUJO_MCP_APP_SANDBOX_PUBLIC_URL: 'Browser-visible sandbox URL; supports an {app} hostname label.',
    FLUJO_MCP_APP_HOST_ORIGINS: 'Comma-separated exact HTTP(S) origins allowed to embed the sandbox.',
    FLUJO_MCP_APP_SANDBOX_ALLOW_ALL: 'Emergency escape hatch that relaxes sandbox and gateway origin checks.',
    FLUJO_MCP_APP_ORIGIN_NAMESPACE: 'Deployment namespace for isolating derived MCP App origins.',
  }),
  ...definitions('access', {
    FLUJO_FS_ROOTS: 'Filesystem hard-ceiling paths separated by the platform path delimiter.',
    FLUJO_BASH_ROOTS: 'Bash hard-ceiling paths; falls back to FLUJO_FS_ROOTS.',
    FLUJO_BASH_INHERIT_ENV: 'Forward the complete main-process environment to bundled Bash when truthy.',
  }),
  ...definitions('bash', {
    FLUJO_BASH_COMMAND_MAX_TIMEOUT_MS: 'Maximum timeout accepted for a Bash command.',
    FLUJO_BASH_MAX_LIVE_SESSIONS: 'Maximum live Bash background and PTY sessions.',
    FLUJO_BASH_SESSION_IDLE_MS: 'Bash session idle expiry in milliseconds.',
    FLUJO_BASH_SESSION_MAX_LIFETIME_MS: 'Bash session absolute lifetime in milliseconds.',
    FLUJO_MCP_DEBUG: 'Enable bundled MCP package debug diagnostics with 1.',
  }),
  ...definitions('browser', Object.fromEntries([
    'ENABLED', 'ALLOWED_ORIGINS', 'ALLOW_PRIVATE_HOSTS', 'RESTRICT_NAVIGATION', 'MODE',
    'EXECUTABLE_PATH', 'PROFILE_DIR', 'LOCALE', 'TIMEZONE_ID', 'EXTENSION_DIRS',
    'WINDOW_VISIBILITY', 'MAX_SESSIONS', 'IDLE_TIMEOUT_MS', 'MAX_REDIRECTS', 'SCREENSHOT_DIR',
    'STREAM_ENABLED', 'STREAM_HOST', 'STREAM_PORT', 'STREAM_PUBLIC_ORIGIN', 'STREAM_QUALITY',
    'STREAM_MAX_WIDTH', 'STREAM_MAX_HEIGHT', 'STREAM_AUDIO', 'VIEWPORT_WIDTH', 'VIEWPORT_HEIGHT',
    'CHANNEL', 'HEADED', 'AUDIO', 'ALLOW_SERVICE_WORKERS', 'ALLOW_LOCAL_CAPTURE',
    'LOCAL_CAPTURE_ROOTS', 'RECORD_DIR', 'RECORD_MAX_MS', 'RECORD_MAX_WIDTH', 'RECORD_MAX_HEIGHT',
    'INLINE_RECORDING_MAX_BYTES',
  ].map((suffix) => [`FLUJO_BROWSER_${suffix}`, `Bundled browser MCP setting: ${suffix.toLowerCase().replaceAll('_', ' ')}.`]))),
  ...definitions('integration', {
    FLUJO_FFMPEG_PATH: 'FFmpeg executable used by browser recording.',
    PLAYWRIGHT_BROWSERS_PATH: 'Playwright browser installation directory.',
    CODEX_HOME: 'Codex home used for model discovery and managed runtime setup.',
    GITHUB_TOKEN: 'GitHub token used to raise package-quality API limits.',
    NODE_OPTIONS: 'Node.js process options; FLUJO may append --use-system-ca.',
    NODE_EXTRA_CA_CERTS: 'Additional Node.js PEM CA bundle.',
    NODE_TLS_REJECT_UNAUTHORIZED: 'Node TLS verification override forwarded to bundled MCP servers.',
    SSL_CERT_FILE: 'TLS CA file forwarded to bundled MCP servers.',
  }),
].map((definition) => ({
  ...definition,
  sensitive: definition.name === 'GITHUB_TOKEN',
}));

export const RUNTIME_ENVIRONMENT_NAMES = new Set(
  RUNTIME_ENVIRONMENT_DEFINITIONS.map(({ name }) => name),
);
