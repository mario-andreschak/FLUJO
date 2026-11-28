import type { ChatAttachmentSettings } from '@/shared/chatAttachments/limits';

/**
 * Enum for storage keys used in the application
 */
export enum StorageKey {
  MODELS = 'models',
  /** Avatar presentation preference; execution remains in the existing runtimes. */
  AVATAR_WORLD = 'avatar_world',
  FLOWS = 'flows',
  TICKETS = 'tickets',
  CHAT_HISTORY = 'history',
  THEME = 'theme',
  // Visual generation is stored separately from light/dark for backwards
  // compatibility with every existing theme preference.
  THEME_STYLE = 'theme_style',
  // The Modern theme's animated landscape is an independent, default-on
  // appearance preference rather than an experimental feature flag.
  LIVING_WORLD_ENABLED = 'living_world_enabled',
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
  /** Per-app decisions used while the optional click-to-display policy is enabled. */
  MCP_APP_CONSENT = 'mcp_app_consent',
  RUN_RESOURCE_SETTINGS = 'run_resource_settings',
  MEMORY_SETTINGS = 'memory_settings',
  SUBFLOW_TASK_SETTINGS = 'subflow_task_settings',
  // Bounds for the remote MCP Tasks lifecycle (issue #404): poll interval
  // clamps, requested TTL, retention and poll-concurrency limits. No secrets.
  MCP_REMOTE_TASK_SETTINGS = 'mcp_remote_task_settings',
  KV_STORE_SETTINGS = 'kv_store_settings',
  PENDING_APPROVALS = 'pending_approvals',
  /** Human steps that wait or recently finished: ids, titles and times only (#1095). */
  HUMAN_TASKS = 'human_tasks',
  // Legacy per-internal-server overrides retained only as migration input.
  MCP_INTERNAL_OVERRIDES = 'mcp_internal_overrides',
  // Durable marker for the one-time migration of shipped internal MCP servers
  // into ordinary MCP_SERVERS records (issue #346).
  MCP_INTERNAL_SERVERS_MIGRATION_V1 = 'mcp_internal_servers_migration_v1',
  // Adds immutable package ids/capabilities to shipped records without claiming
  // a user-defined configuration that happens to reuse a former built-in name.
  MCP_INTERNAL_CAPABILITIES_MIGRATION_V2 = 'mcp_internal_capabilities_migration_v2',
  // Seeds the browser package for installations whose original built-in migration
  // completed before the browser server shipped (issue #334).
  MCP_INTERNAL_BROWSER_MIGRATION_V3 = 'mcp_internal_browser_migration_v3',
  // Converts previously provisioned package records to normal stdio launch fields
  // and removes the legacy internal-package metadata (issue #347).
  MCP_SHIPPED_SERVERS_MIGRATION_V4 = 'mcp_shipped_servers_migration_v4',
  // Backfills the absolute package root omitted from earlier shipped-server records.
  MCP_SHIPPED_SERVER_ROOTS_MIGRATION_V5 = 'mcp_shipped_server_roots_migration_v5',
  // Repairs browser records created under the former @flujo-ai package id and
  // clears stale process-status fields that could preserve a duplicated path.
  MCP_SHIPPED_BROWSER_REPAIR_MIGRATION_V6 = 'mcp_shipped_browser_repair_migration_v6',
  // Repairs FLUJO control-server records created under the former @flujo-ai
  // package id so they launch the current installation instead of a stale
  // workspace-local package copy.
  MCP_SHIPPED_FLUJO_REPAIR_MIGRATION_V7 = 'mcp_shipped_flujo_repair_migration_v7',
  // Repairs Bash records that still launch a copied workspace package instead
  // of the version shipped with the current FLUJO installation.
  MCP_SHIPPED_BASH_REPAIR_MIGRATION_V8 = 'mcp_shipped_bash_repair_migration_v8',
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
  TELEMETRY_STATE = 'telemetry_state',
  /** Workspace-scoped retention policy for derived filesystem snapshots (#414). */
  SNAPSHOT_RETENTION_POLICY = 'snapshot_retention_policy',
  /** Memory embeddings sidecar collection (issue #451), keyed by safe Persona id. */
  MEMORY_EMBEDDINGS = 'memory_embeddings',
  /** Persona history cleanup rollout: measuring or cleaning up, and why (#481). */
  PERSONA_RUNTIME_RETENTION_STATE = 'persona_runtime_retention_state'
}

export const StorageKeys = {
  MODELS: StorageKey.MODELS,
  FLOWS: StorageKey.FLOWS,
  CHAT_HISTORY: StorageKey.CHAT_HISTORY,
  THEME: StorageKey.THEME,
  THEME_STYLE: StorageKey.THEME_STYLE,
  LIVING_WORLD_ENABLED: StorageKey.LIVING_WORLD_ENABLED,
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
  MCP_APP_CONSENT: StorageKey.MCP_APP_CONSENT,
  RUN_RESOURCE_SETTINGS: StorageKey.RUN_RESOURCE_SETTINGS,
  MEMORY_SETTINGS: StorageKey.MEMORY_SETTINGS,
  SUBFLOW_TASK_SETTINGS: StorageKey.SUBFLOW_TASK_SETTINGS,
  MCP_REMOTE_TASK_SETTINGS: StorageKey.MCP_REMOTE_TASK_SETTINGS,
  KV_STORE_SETTINGS: StorageKey.KV_STORE_SETTINGS,
  PENDING_APPROVALS: StorageKey.PENDING_APPROVALS,
  HUMAN_TASKS: StorageKey.HUMAN_TASKS,
  MCP_INTERNAL_OVERRIDES: StorageKey.MCP_INTERNAL_OVERRIDES,
  MCP_INTERNAL_SERVERS_MIGRATION_V1: StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1,
  MCP_INTERNAL_CAPABILITIES_MIGRATION_V2: StorageKey.MCP_INTERNAL_CAPABILITIES_MIGRATION_V2,
  MCP_INTERNAL_BROWSER_MIGRATION_V3: StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3,
  MCP_SHIPPED_SERVERS_MIGRATION_V4: StorageKey.MCP_SHIPPED_SERVERS_MIGRATION_V4,
  MCP_SHIPPED_SERVER_ROOTS_MIGRATION_V5: StorageKey.MCP_SHIPPED_SERVER_ROOTS_MIGRATION_V5,
  MCP_SHIPPED_BROWSER_REPAIR_MIGRATION_V6: StorageKey.MCP_SHIPPED_BROWSER_REPAIR_MIGRATION_V6,
  MCP_SHIPPED_FLUJO_REPAIR_MIGRATION_V7: StorageKey.MCP_SHIPPED_FLUJO_REPAIR_MIGRATION_V7,
  MCP_SHIPPED_BASH_REPAIR_MIGRATION_V8: StorageKey.MCP_SHIPPED_BASH_REPAIR_MIGRATION_V8,
  PACKAGE_INSTALLS: StorageKey.PACKAGE_INSTALLS,
  EXPERIMENTAL_SETTINGS: StorageKey.EXPERIMENTAL_SETTINGS,
  REGISTRY_ACCOUNT: StorageKey.REGISTRY_ACCOUNT,
  REGISTRY_SETTINGS: StorageKey.REGISTRY_SETTINGS,
  TELEMETRY_STATE: StorageKey.TELEMETRY_STATE,
  SNAPSHOT_RETENTION_POLICY: StorageKey.SNAPSHOT_RETENTION_POLICY,
  MEMORY_EMBEDDINGS: StorageKey.MEMORY_EMBEDDINGS,
  PERSONA_RUNTIME_RETENTION_STATE: StorageKey.PERSONA_RUNTIME_RETENTION_STATE,
} as const;

/**
 * Speech recognition settings interface
 */
export interface SpeechSettings {
  enabled: boolean;
  language?: string;
  /**
   * ID of an existing OpenAI-format model used for prerecorded audio.
   * The model's endpoint and encrypted credentials remain in the model store.
   */
  transcriptionModelId?: string;
}

/**
 * Auto-update settings interface
 */
export interface UpdateSettings {
  /** When true, the landing page checks GitHub for a newer commit on startup. */
  checkOnStartup: boolean;
}

/**
 * Stable identifiers for the individually dismissible dashboard cards. These
 * never depend on translated titles or array positions so persisted state stays
 * valid across copy and layout changes.
 */
export type DashboardCardId = 'ai' | 'assistant' | 'talk' | 'connectedApps';

/** Canonical order used when persisting dismissed dashboard cards. */
export const DASHBOARD_CARD_IDS: readonly DashboardCardId[] = ['ai', 'assistant', 'talk', 'connectedApps'];

/**
 * Cards covered by the removed collective "hide completed setup steps" toggle.
 * The legacy flag never hid the connected-apps notice, so it must not be
 * migrated as if it did.
 */
export const LEGACY_HIDDEN_DASHBOARD_CARD_IDS: readonly DashboardCardId[] = ['ai', 'assistant', 'talk'];

/** Type guard used when reading persisted values that may predate this type. */
export function isDashboardCardId(value: unknown): value is DashboardCardId {
  return typeof value === 'string' && (DASHBOARD_CARD_IDS as readonly string[]).includes(value);
}

/**
 * Onboarding / guided-tour settings interface
 */
export interface OnboardingSettings {
  /** True once the user has finished or skipped the first-run guided tour. */
  completed: boolean;
  /**
   * Legacy collective hide flag for the three-card setup journey. Kept only so
   * existing installs keep their hidden cards hidden; new dismissals are stored
   * in `dashboardDismissedCards`.
   */
  dashboardCardsHidden?: boolean;
  /** Dashboard cards the user dismissed individually via their X control. */
  dashboardDismissedCards?: DashboardCardId[];
  /** Progress for the first hands-on tutorial that follows onboarding. */
  tutorials?: TutorialSettings;
}

export type TutorialStatus = 'active' | 'paused' | 'completed' | 'cancelled';

/**
 * Durable tutorial state. Step ids, rather than array indexes, make a paused
 * tutorial safe to resume after copy or step-order changes. The optional
 * nested id is also used as the visual parent for a short prerequisite tour.
 */
export interface TutorialProgress {
  status: TutorialStatus;
  stepId: string;
  flowId?: string;
  processNodeId?: string;
  taskPrompt?: string;
  conversationId?: string;
  recommendedServerName?: string;
  nestedTutorialId?: 'install-web-app' | 'enable-web-app';
}

export interface TutorialSettings {
  bigTutorialStage1?: TutorialProgress;
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

/** How broadly the FLUJO web server and MCP Apps sandbox are exposed. */
export type ExposureMode = 'localhost' | 'network' | 'public';

export interface NetworkSettings {
  /**
   * `localhost` binds only to this computer; `network` accepts private-LAN
   * addresses and this machine's hostnames; `public` accepts any hostname and
   * is intended only behind an authenticating HTTPS reverse proxy.
   */
  exposure: ExposureMode;
  /**
   * When true, the MCP Apps sandbox accepts any embedder/child origin instead
   * of enforcing the host-origin allowlist. This disables the cross-origin
   * isolation boundary and is intended only as an escape hatch for hosted
   * deployments behind a reverse proxy that rewrites Host/Referer headers.
   * Defaults to false (secure).
   */
  allowAllMcpAppContent?: boolean;
}

/**
 * Advanced settings (issue #184). Switches retired by #1449 are listed in
 * `src/shared/config/retiredSettings.ts`.
 */
export interface ExperimentalSettings {
  /**
   * When true, an MCP App that has already passed the per-server
   * `enableMcpApps` permission still waits for an explicit launch click in chat
   * and the tool tester. Missing/false keeps the user-friendly default: allowed
   * apps reveal themselves immediately.
   */
  requireMcpAppLaunchClick?: boolean;
  /**
   * Constrain MCP servers (including the shipped filesystem and bash packages)
   * to configured server/node roots. This is opt-in; when missing/false the
   * host advertises every filesystem root so trusted tools work everywhere.
   * Operator environment ceilings remain authoritative either way.
   */
  restrictMcpFilesystemToRoots?: boolean;
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
   * Head-room, in tokens, kept free below the model's context window when
   * deciding whether to compact pre-flight (compact when the estimated request
   * size exceeds contextWindow − max(maxTokens, this)).
   * Missing ⇒ 50000 (~40% of 128k context, targets 30-60% usage).
   */
  compactionBufferTokens?: number;
  /**
   * How many tokens of the most-recent conversation tail are kept VERBATIM when
   * compacting (everything older is summarized).
   * Missing ⇒ 19000 (~15% of 128k context, targets 30-60% usage).
   */
  compactionKeepTokens?: number;
  /** Optional 1–100 percent context threshold; per-model settings take precedence. */
  compactionThresholdPercent?: number;
  /**
   * How many of the most-recent wire messages `compactForWire` keeps VERBATIM
   * (everything older is eligible for lossless wire-only shrinking of oversized
   * old tool results / old assistant prose). Missing ⇒ 6 (the new default).
   * Issue #286: short-but-tool-heavy conversations (a single message that fans
   * out into dozens of MCP tool-loop turns) never crossed the 12 threshold, so
   * they got NO compaction and re-sent every fat tool result on every turn.
   * Lowering this to 6 lets those runs benefit from wire-only shrinking.
   * Wire-only and lossless — the persisted transcript is untouched — but a lower
   * value shifts the recent/old boundary, so the first turn after a change can
   * cost one prompt-cache miss. Values below 2 are clamped to 2.
   */
  historyKeepRecentMessages?: number;
}

/**
 * Settings interface containing all application settings
 */
/** Per-workspace switches for reaching a model without a saved flow. Missing means on. */
export interface ModelAccessSettings {
  /** `false` refuses and hides `model-<id>` and `policy/<id>` on the `/v1` API. */
  directModelCalls?: boolean;
  /** `false` refuses Quick Chat and what is built on it: Ask FLUJO and the Flow Generator. */
  quickChat?: boolean;
}

export interface McpStartupSettings {
  /** Start tool servers on first use instead of with FLUJO. Off when missing. */
  lazyStart?: boolean;
}

export interface Settings {
  speech: SpeechSettings;
  update?: UpdateSettings;
  onboarding?: OnboardingSettings;
  telemetry?: TelemetrySettings;
  /** Missing on existing installs; the secure default is localhost-only. */
  network?: NetworkSettings;
  /**
   * Advanced settings; missing values use their defaults.
   */
  experimental?: ExperimentalSettings;
  modelAccess?: ModelAccessSettings;
  mcp?: McpStartupSettings;
  /** Size limits for files added to a chat (#1224). Missing values use defaults. */
  chatAttachments?: ChatAttachmentSettings;
}
