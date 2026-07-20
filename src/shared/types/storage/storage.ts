/**
 * Enum for storage keys used in the application
 */
export enum StorageKey {
  MODELS = 'models',
  FLOWS = 'flows',
  CHAT_HISTORY = 'history',
  THEME = 'theme',
  ENCRYPTION_KEY = 'encryption_key',
  MCP_SERVERS = 'mcp_servers',
  GLOBAL_ENV_VARS = 'global_env_vars',
  CURRENT_CONVERSATION_ID = 'current_conversation_id',
  SELECTED_FLOW_ID = 'selected_flow_id',
  LAST_PICKED_FLOW_ID = 'last_picked_flow_id',
  SPEECH_SETTINGS = 'speech_settings',
  SPOTLIGHT_SERVERS = 'spotlight_servers',
  PLANNED_EXECUTIONS = 'planned_executions',
  MCP_AUTO_INSTALL_SETTINGS = 'mcp_auto_install_settings',
  MCP_QUALITY_SETTINGS = 'mcp_quality_settings',
  RUN_RESOURCE_SETTINGS = 'run_resource_settings',
  KV_STORE_SETTINGS = 'kv_store_settings',
  PENDING_APPROVALS = 'pending_approvals',
  // Per-built-in-server overrides (issue #170). Only a tiny { disabled } flag is
  // persisted here; the synthetic built-in configs themselves are NEVER stored.
  MCP_INTERNAL_OVERRIDES = 'mcp_internal_overrides',
  // Package installs ledger (issue #198): last install summary + the ids of the
  // entities each installed package created, so re-installs are idempotent and
  // the status endpoint can report the last outcome. Never stores secret values.
  PACKAGE_INSTALLS = 'package_installs',
  // Experimental features toggle (issue #184): a single boolean gating
  // in-progress/unstable UI (e.g. the Waves nav entry). UI-only flag.
  EXPERIMENTAL_SETTINGS = 'experimental_settings'
}

export const StorageKeys = {
  MODELS: StorageKey.MODELS,
  FLOWS: StorageKey.FLOWS,
  CHAT_HISTORY: StorageKey.CHAT_HISTORY,
  THEME: StorageKey.THEME,
  ENCRYPTION_KEY: StorageKey.ENCRYPTION_KEY,
  MCP_SERVERS: StorageKey.MCP_SERVERS,
  GLOBAL_ENV_VARS: StorageKey.GLOBAL_ENV_VARS,
  CURRENT_CONVERSATION_ID: StorageKey.CURRENT_CONVERSATION_ID,
  SELECTED_FLOW_ID: StorageKey.SELECTED_FLOW_ID,
  LAST_PICKED_FLOW_ID: StorageKey.LAST_PICKED_FLOW_ID,
  SPEECH_SETTINGS: StorageKey.SPEECH_SETTINGS,
  SPOTLIGHT_SERVERS: StorageKey.SPOTLIGHT_SERVERS,
  PLANNED_EXECUTIONS: StorageKey.PLANNED_EXECUTIONS,
  MCP_AUTO_INSTALL_SETTINGS: StorageKey.MCP_AUTO_INSTALL_SETTINGS,
  MCP_QUALITY_SETTINGS: StorageKey.MCP_QUALITY_SETTINGS,
  RUN_RESOURCE_SETTINGS: StorageKey.RUN_RESOURCE_SETTINGS,
  KV_STORE_SETTINGS: StorageKey.KV_STORE_SETTINGS,
  PENDING_APPROVALS: StorageKey.PENDING_APPROVALS,
  MCP_INTERNAL_OVERRIDES: StorageKey.MCP_INTERNAL_OVERRIDES,
  PACKAGE_INSTALLS: StorageKey.PACKAGE_INSTALLS,
  EXPERIMENTAL_SETTINGS: StorageKey.EXPERIMENTAL_SETTINGS,
} as const;

/**
 * Speech recognition settings interface
 */
export interface SpeechSettings {
  enabled: boolean;
  language?: string;
}

/**
 * Auto-update settings interface
 */
export interface UpdateSettings {
  /** When true, the landing page checks GitHub for a newer commit on startup. */
  checkOnStartup: boolean;
}

/**
 * Onboarding / guided-tour settings interface
 */
export interface OnboardingSettings {
  /** True once the user has finished or skipped the first-run guided tour. */
  completed: boolean;
}

/**
 * Experimental-features settings interface (issue #184)
 */
export interface ExperimentalSettings {
  /** When true, experimental UI (e.g. the Waves nav entry) is revealed. */
  enabled: boolean;
}

/**
 * Settings interface containing all application settings
 */
export interface Settings {
  speech: SpeechSettings;
  update?: UpdateSettings;
  onboarding?: OnboardingSettings;
  /**
   * Optional so existing persisted settings load unchanged; a missing value is
   * treated as disabled (experimental features hidden).
   */
  experimental?: ExperimentalSettings;
}
