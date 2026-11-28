export type RuntimeEnvironmentCategory =
  | 'runtime'
  | 'mcpApps'
  | 'access'
  | 'integration';

export interface RuntimeEnvironmentDefinition {
  name: string;
  category: RuntimeEnvironmentCategory;
  description: string;
  sensitive?: boolean;
}

function definitions(
  category: RuntimeEnvironmentCategory,
  entries: Record<string, string>,
): RuntimeEnvironmentDefinition[] {
  return Object.entries(entries).map(([name, description]) => ({ name, category, description }));
}

/**
 * Where and how FLUJO runs, set by whoever installs or hosts it and edited in
 * Settings > Runtime environment. Only deployment and security boundaries
 * belong here (#1449); every other variable FLUJO reads is listed with its
 * reason in `src/shared/environmentAllowlist.ts`.
 */
export const RUNTIME_ENVIRONMENT_DEFINITIONS: RuntimeEnvironmentDefinition[] = [
  ...definitions('runtime', {
    FLUJO_PORT: 'Main HTTP port (default 4200).',
    FLUJO_DATA_DIR: 'Installation data root. Changing it also changes where this settings file is read from.',
    FLUJO_BASE_URL: 'Canonical URL used by FLUJO and bundled MCP clients.',
    FLUJO_BROWSER_URL: 'URL opened after startup; falls back to FLUJO_BASE_URL.',
    FLUJO_EXPOSURE_MODE: 'Listener mode: localhost, network, or public.',
    FLUJO_OLLAMA_URL: 'Ollama endpoint (default http://localhost:11434). Setting it also offers local models while Ollama starts.',
    FLUJO_REGISTRY_BASE_URL: 'Use your own FLUJO package registry instead of the public one.',
    FLUJO_EXTRA_CA_CERTS: 'Path to an additional PEM CA bundle.',
  }),
  ...definitions('mcpApps', {
    FLUJO_MCP_APP_SANDBOX_PORT: 'MCP Apps sandbox listener port (default 4201).',
    FLUJO_MCP_APP_SANDBOX_HOST: 'Explicit MCP Apps sandbox bind address.',
    FLUJO_MCP_APP_SANDBOX_PUBLIC_URL: 'Browser-visible sandbox URL; supports an {app} hostname label.',
    FLUJO_MCP_APP_HOST_ORIGINS: 'Comma-separated exact HTTP(S) origins allowed to embed the sandbox.',
    FLUJO_MCP_APP_ORIGIN_NAMESPACE: 'Deployment namespace for isolating derived MCP App origins.',
  }),
  ...definitions('access', {
    FLUJO_FS_ROOTS: 'Filesystem hard-ceiling paths separated by the platform path delimiter.',
    FLUJO_BASH_ROOTS: 'Bash hard-ceiling paths; falls back to FLUJO_FS_ROOTS.',
  }),
  ...definitions('integration', {
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
