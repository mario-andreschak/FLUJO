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
  // Legacy per-internal-server overrides retained only as migration input.
  MCP_INTERNAL_OVERRIDES = 'mcp_internal_overrides',
  // Durable marker for the one-time migration of shipped internal MCP servers
  // into ordinary MCP_SERVERS records (issue #346).
  MCP_INTERNAL_SERVERS_MIGRATION_V1 = 'mcp_internal_servers_migration_v1',
  // Adds immutable package ids/capabilities to shipped records without claiming
  // a user-defined configuration that happens to reuse a former built-in name.
  MCP_INTERNAL_CAPABILITIES_MIGRATION_V2 = 'mcp_internal_capabilities_migration_v2',
  // Package installs ledger (issue #198): last install summary + the ids of the
  // entities each installed package created, so re-installs are idempotent and
  // the status endpoint can report the last outcome. Never stores secret values.
  PACKAGE_INSTALLS = 'package_installs',
  // Experimental features toggle (issue #184): a single boolean gating
  // in-progress/unstable UI (e.g. the Waves nav entry). UI-only flag.
  EXPERIMENTAL_SETTINGS = 'experimental_settings',
  // Package-registry account (issue #197): encrypted JWT/refresh tokens plus
  // masked account metadata (publisher handle, email, confirmation state) for
  // publishing to the hosted package registry. Tokens are stored with the same
  // at-rest posture as model API keys and are NEVER rendered to the browser.
  REGISTRY_ACCOUNT = 'registry_account',
  // Package-registry settings (issue #197): user-configured registry base URL
  // (blank => use the built-in production default). No secrets.
  REGISTRY_SETTINGS = 'registry_settings',
  // Anonymous daily-activity delivery state. Contains only UTC dates and the
  // current day's rotating random id; never a permanent installation id.
  TELEMETRY_STATE = 'telemetry_state'
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
  MCP_INTERNAL_SERVERS_MIGRATION_V1: StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1,
  MCP_INTERNAL_CAPABILITIES_MIGRATION_V2: StorageKey.MCP_INTERNAL_CAPABILITIES_MIGRATION_V2,
  PACKAGE_INSTALLS: StorageKey.PACKAGE_INSTALLS,
  EXPERIMENTAL_SETTINGS: StorageKey.EXPERIMENTAL_SETTINGS,
  REGISTRY_ACCOUNT: StorageKey.REGISTRY_ACCOUNT,
  REGISTRY_SETTINGS: StorageKey.REGISTRY_SETTINGS,
  TELEMETRY_STATE: StorageKey.TELEMETRY_STATE,
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
 * Privacy-preserving usage-count settings. Missing values deliberately map to
 * true because this feature is opt-out, while remaining visible and reversible.
 */
export interface TelemetrySettings {
  /** Share at most one anonymous active-install pulse per UTC day. */
  enabled: boolean;
  /** Show the daily disclosure after FLUJO performs its telemetry check. */
  notifyDaily: boolean;
}

/**
 * Experimental-features settings interface (issue #184)
 */
export interface ExperimentalSettings {
  /** When true, experimental UI (e.g. the Waves nav entry) is revealed. */
  enabled: boolean;
  /**
   * Reveal models that the provider explicitly reports as lacking tool-call
   * support in provider catalogue/picker results. Off by default. Models whose
   * provider exposes no capability metadata remain visible.
   */
  showModelsWithoutToolCapabilities?: boolean;
  /**
   * Run Generate Flow through the editable, multi-stage system Flow instead of
   * the production generate/improve services. Off by default: the Flow-based
   * implementation is intentionally an experimental alternative while the
   * sophisticated service-backed generator remains the reliable default.
   */
  flowBasedGenerator?: boolean;
  /**
   * When true, the Claude Subscription adapter REUSES its Agent SDK session
   * across turns of the same single-node Flow — resuming the persisted session
   * (`resume`) and sending only the per-turn delta instead of re-flattening the
   * whole conversation each turn (issue #154). Off by default: it changes how
   * conversation context reaches the model, so it stays opt-in until verified on
   * real token curves. Independent of `enabled` (a backend behaviour, not a UI
   * reveal). A missing value is treated as disabled.
   */
  claudeSessionResume?: boolean;
  /**
   * When true, MCP client connections are built on the v2 beta SDK
   * (`@modelcontextprotocol/client`, spec revision 2026-07-28) with automatic
   * version negotiation: the client probes each server and speaks the new
   * stateless protocol when the server supports it, transparently falling back
   * to the classic `initialize` handshake for every existing server. Off by
   * default: the beta SDK's public API may still change before its stable
   * release, so connections stay on the proven v1 SDK unless the user opts in.
   * Websocket transports always stay on v1 (the v2 SDK has no websocket
   * transport). A missing value is treated as disabled.
   */
  mcpBetaProtocol?: boolean;
  /**
   * When true, FLUJO automatically unloads the previously-loaded Ollama model
   * from VRAM before sending a completion request for a different model on the
   * same Ollama server URL. This frees GPU memory on constrained hardware.
   * Requests to the same Ollama URL are serialised while this is on, so it adds
   * a small latency in parallel fan-out scenarios. Off by default: zero impact
   * on existing behaviour.
   */
  autoUnloadOllamaModels?: boolean;
  /**
   * When true, the built-in filesystem and bash MCP servers block sensitive
   * home-directory locations even when a configured root would otherwise allow
   * them. Off by default: configured roots are an explicit user grant and take
   * precedence unless this additional defense-in-depth layer is opted into.
   */
  protectedPathsEnabled?: boolean;
  /**
   * When false, filesystem snapshots and snapshot-based revert are disabled.
   * Missing values default to true to preserve existing installations.
   */
  snapshotsEnabled?: boolean;
  /**
   * Cap, in characters, on each tool DESCRIPTION sent to the model. 0 / undefined
   * disables capping.
   *
   * The tool block is the largest fixed cost of a tool-using step (~20k tokens for
   * a few bound MCP servers) and stateless Chat Completions re-sends it every turn.
   * Lossless trimming — schema bookkeeping keywords, redundant titles, template
   * literal indentation — is always applied and needs no setting. This value
   * enables the LOSSY tier: verbose servers are where the real tokens are, but
   * shortening a description removes information the model might have used, so it
   * stays opt-in. Truncation lands on a sentence boundary, and per-property
   * descriptions get a quarter of this budget. ~600–1000 is a reasonable starting
   * point; a missing value keeps every description intact.
   */
  toolDescriptionMaxChars?: number;
  /**
   * When true, FLUJO applies SUMMARIZING COMPACTION to long conversations
   * (issue #248): before a request that would overflow the model's context
   * window — and after a context-length error — it summarizes the older part of
   * the persisted history into an anchored summary head and continues, instead
   * of only shrinking the wire copy. Off by default: it MUTATES persisted
   * conversation history (behind a recoverable run-resource anchor), so it stays
   * opt-in until verified. A missing value is treated as disabled.
   */
  compactionEnabled?: boolean;
  /**
   * Head-room, in tokens, kept free below the model's context window when
   * deciding whether to compact pre-flight (compact when the estimated request
   * size exceeds contextWindow − max(maxTokens, this)). Only meaningful when
   * `compactionEnabled`. Missing ⇒ 20000.
   */
  compactionBufferTokens?: number;
  /**
   * How many tokens of the most-recent conversation tail are kept VERBATIM when
   * compacting (everything older is summarized). Only meaningful when
   * `compactionEnabled`. Missing ⇒ 8000.
   */
  compactionKeepTokens?: number;
  /**
   * How many of the most-recent wire messages `compactForWire` keeps VERBATIM
   * (everything older is eligible for lossless wire-only shrinking of oversized
   * old tool results / old assistant prose). Missing ⇒ 12 (the historical
   * default). Issue #286: short-but-tool-heavy conversations (a single message
   * that fans out into dozens of MCP tool-loop turns) never crossed the 12
   * threshold, so they got NO compaction and re-sent every fat tool result on
   * every turn. Lowering this (e.g. 6) lets those runs benefit from wire-only
   * shrinking. Wire-only and lossless — the persisted transcript is untouched —
   * but a lower value shifts the recent/old boundary, so the first turn after a
   * change can cost one prompt-cache miss. Values below 2 are clamped to 2.
   */
  historyKeepRecentMessages?: number;
}

/**
 * Settings interface containing all application settings
 */
export interface Settings {
  speech: SpeechSettings;
  update?: UpdateSettings;
  onboarding?: OnboardingSettings;
  telemetry?: TelemetrySettings;
  /**
   * Optional so existing persisted settings load unchanged; a missing value is
   * treated as disabled (experimental features hidden).
   */
  experimental?: ExperimentalSettings;
}
