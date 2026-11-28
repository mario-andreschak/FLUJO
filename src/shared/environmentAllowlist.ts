import { RUNTIME_ENVIRONMENT_DEFINITIONS } from './runtimeEnvironment';

/**
 * Every environment variable FLUJO's own code (`src/`) may read, with the
 * reason it exists (#1449). A feature is on by default and falls back by
 * itself; it never waits behind a variable.
 *
 * - `operator`: where and how FLUJO runs; edited in Settings > Runtime environment
 *   (`RUNTIME_ENVIRONMENT_DEFINITIONS`).
 * - `security`: a secret, a policy file or a hard limit the host owner sets.
 * - `install`: copied once into a new bundled tool server's own settings, where
 *   it is changed afterwards.
 * - `process`: FLUJO or its launcher sets it for its own processes.
 * - `platform`: a standard variable of the operating system, Node.js or a
 *   program FLUJO talks to.
 * - `test`: only tests, benchmarks and acceptance runs set it; most are read
 *   through `testSetting()`, which ignores them outside tests.
 * - `pending`: read only inside files the running #571 split owns; the second
 *   #1449 pass removes it.
 *
 * `__tests__/architecture/noFeatureSwitches.test.ts` fails when `src/` reads a
 * name that is not listed here, or when a listed name is no longer read.
 */
export type EnvironmentKind =
  | 'operator'
  | 'security'
  | 'install'
  | 'process'
  | 'platform'
  | 'test'
  | 'pending';

export interface EnvironmentEntry {
  kind: EnvironmentKind;
  reason: string;
}

const operator: Record<string, EnvironmentEntry> = Object.fromEntries(
  RUNTIME_ENVIRONMENT_DEFINITIONS.map(({ name, description }) => [name, { kind: 'operator', reason: description }]),
);

function entries(kind: EnvironmentKind, reasons: Record<string, string>): Record<string, EnvironmentEntry> {
  return Object.fromEntries(Object.entries(reasons).map(([name, reason]) => [name, { kind, reason }]));
}

export const ENVIRONMENT_ALLOWLIST: Readonly<Record<string, EnvironmentEntry>> = Object.freeze({
  ...operator,
  ...entries('security', {
    FLUJO_ENCRYPTION_SECRET_FILE: 'Servers keep the workspace key in a file the host owner provides.',
    FLUJO_OWNER_AUTH_FILE: 'Owner sign-in policy for hosted installs.',
    FLUJO_OWNER_BOOTSTRAP_FILE: 'One-time owner set-up token for hosted installs.',
    FLUJO_OWNER_BROWSER_ORIGIN: 'The only browser origin allowed to sign in as owner on a hosted install.',
    FLUJO_MCP_TRUSTED_HOST_FILE: 'Host-owned list of tool servers allowed to run on the host itself.',
    FLUJO_MCP_ISOLATION_FILE: 'Host-owned isolation policy for tool servers.',
    FLUJO_SKILLSPECTOR_IMAGE: 'Pinned local container image for skill security reviews.',
    FLUJO_SYSTEM_SCREENSHOT_ENABLED: 'Privacy: lets a model see the whole desktop, so the FLUJO tool server only offers it when its host turns it on.',
    FLUJO_EXTRA_LOCAL_HOSTS: 'Old hosted installs that never saved Settings > Network exposure keep their trusted host names.',
    FLUJO_AVATAR_OPENROUTER_KEY: 'Separate key for the avatar voice service.',
    FLUJO_OAUTH_CLIENT_METADATA_URL: 'Self-hosted MCP sign-in client metadata.',
  }),
  ...entries('install', {
    FLUJO_BROWSER_ENABLED: 'Host can leave the bundled browser tool off.',
    FLUJO_BROWSER_ALLOWED_ORIGINS: 'Host limit on the sites the bundled browser may open.',
    FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS: 'Host limit on private network addresses for the bundled browser.',
    FLUJO_BROWSER_RESTRICT_NAVIGATION: 'Host limit on navigation for the bundled browser.',
    FLUJO_BROWSER_ALLOW_SERVICE_WORKERS: 'Host limit on service workers for the bundled browser.',
    FLUJO_BROWSER_ALLOW_LOCAL_CAPTURE: 'Host limit on local file capture for the bundled browser.',
    FLUJO_BROWSER_LOCAL_CAPTURE_ROOTS: 'Folders the bundled browser may capture from.',
    FLUJO_BROWSER_EXECUTABLE_PATH: 'Where the browser program lives on this host.',
    FLUJO_BROWSER_CHANNEL: 'Which installed browser build to use on this host.',
    FLUJO_FFMPEG_PATH: 'Where FFmpeg lives on this host, for browser recordings.',
    FLUJO_BROWSER_STREAM_ENABLED: 'Hosted installs can turn the browser live view off.',
    FLUJO_BROWSER_STREAM_HOST: 'Bind address of the browser live view on hosted installs.',
    FLUJO_BROWSER_STREAM_PORT: 'Port of the browser live view on hosted installs.',
    FLUJO_BROWSER_STREAM_PUBLIC_ORIGIN: 'Public address of the browser live view behind a proxy.',
    FLUJO_BROWSER_PROFILE_DIR: 'FLUJO points the browser profile into the workspace.',
    FLUJO_BROWSER_SCREENSHOT_DIR: 'FLUJO points browser screenshots into the workspace.',
    FLUJO_BROWSER_RECORD_DIR: 'FLUJO points browser recordings into the workspace.',
  }),
  ...entries('process', {
    FLUJO_APP_ROOT: 'The launcher tells the server where the application files are.',
    FLUJO_RUNTIME_ENV_DIR: 'The launcher tells the server where .env.local lives.',
    FLUJO_CONTAINER: 'The Docker image marks the install as container-managed.',
    FLUJO_NPM: 'The npm launcher marks the install as npm-managed.',
    FLUJO_BUILD_REVISION: 'The build records which source revision it came from.',
    FLUJO_EXPOSURE_MODE_SOURCE: 'The launcher says where the exposure mode came from.',
    FLUJO_RUNTIME_LOCAL_HOSTS: 'The launcher passes the host names it found for this machine.',
    FLUJO_MCP_APP_SANDBOX_ALLOW_ALL: 'The launcher passes Settings > Network "allow all MCP App content".',
    FLUJO_PARENT_DATA_DIR: 'FLUJO tells its tool servers the installation data root.',
    FLUJO_WORKSPACE: 'FLUJO tells its tool servers which workspace they serve.',
    FLUJO_MCP_WORKLOAD_TOKEN: 'Short-lived credential FLUJO hands to its own tool server.',
    FLUJO_MCP_WORKLOAD_AUDIENCE: 'Audience of that short-lived credential.',
    FLUJO_MCP_APP_RUNTIME_REGISTER_URL: 'Where a bundled server registers its MCP App runtime.',
    FLUJO_MCP_APP_RUNTIME_REGISTER_TOKEN: 'Credential for that registration.',
    FLUJO_SNAPSHOT_CONTROL_TOKEN: 'Credential for workspace snapshot transfer between FLUJO processes.',
    FLUJO_WORKER_MODE: 'A cloud worker runs one restored workspace.',
    FLUJO_WORKER_SNAPSHOT: 'The workspace snapshot a worker restores.',
    FLUJO_WORKER_SNAPSHOT_KEY: 'Key of that snapshot.',
    FLUJO_WORKER_SNAPSHOT_SHA256: 'Checksum of that snapshot.',
    FLUJO_WORKER_SNAPSHOT_SOURCE: 'Where that snapshot came from.',
    FLUJO_WORKER_RECOVERY_ID: 'Recovery run a worker belongs to.',
    FLUJO_WORKER_RECOVERY_EPOCH: 'Recovery generation a worker belongs to.',
    FLUJO_SNAPSHOT_MAX_BYTES: 'Cloud worker images set the snapshot size limit of their machine.',
    FLUJO_SNAPSHOT_MAX_FILE_BYTES: 'Cloud worker images set the per-file snapshot limit of their machine.',
    FLUJO_NATIVE_CODEX_PROFILE: 'FLUJO passes a native Codex profile to its own child process.',
    FLUJO_NATIVE_PARENT_MODULE: 'FLUJO passes its native parent module to its own child process.',
    FLUJO_NATIVE_SOURCE_ORIGIN: 'FLUJO passes the native source origin to its own child process.',
    FLUJO_NATIVE_TOOL_ORIGIN: 'FLUJO passes the native tool origin to its own child process.',
    FLUJO_EXECUTION_ADAPTER_MODULE: 'An installed execution extension names its module.',
    FLUJO_QUALIFICATION_KEY: 'Codex conversation qualification names this key in its own records.',
    FLUJO_AVATAR_PHONE_HOST: 'The avatar phone build runs FLUJO as a phone host.',
    FLUJO_AVATAR_POCKET_ORIGIN: 'The avatar phone build names its local speech service.',
    FLUJO_AVATAR_REMOTE_ORIGIN: 'The avatar phone build names its remote voice service.',
  }),
  ...entries('platform', {
    NODE_ENV: 'Node.js and Next.js run mode.',
    NEXT_RUNTIME: 'Next.js says which runtime runs the code.',
    PATH: 'Where programs are found.',
    Path: 'Windows spelling of PATH.',
    HOME: 'The user home folder.',
    USERPROFILE: 'Windows user home folder.',
    HOMEDRIVE: 'Windows home drive.',
    HOMEPATH: 'Windows home path.',
    LOCALAPPDATA: 'Windows per-user program data.',
    SystemRoot: 'Windows system folder.',
    SYSTEMROOT: 'Windows system folder, other spelling.',
    WINDIR: 'Windows folder.',
    ComSpec: 'Windows command shell.',
    SESSIONNAME: 'Windows session kind, to tell remote desktops apart.',
    XDG_CACHE_HOME: 'Linux cache folder.',
    DISPLAY: 'Linux X11 display, for desktop screenshots.',
    WAYLAND_DISPLAY: 'Linux Wayland display, for desktop screenshots.',
    DBUS_SESSION_BUS_ADDRESS: 'Linux desktop session bus, for the system key store.',
    TERM: 'Terminal kind, for migration progress output.',
    CI: 'Continuous integration runs get plain migration output.',
    COLORTERM: 'Terminal colour support.',
    FORCE_COLOR: 'Terminal colour override.',
    OPENAI_API_KEY: 'Standard key of the OpenAI tools FLUJO starts.',
    OPENAI_BASE_URL: 'Standard endpoint of the OpenAI tools FLUJO starts.',
    OPENROUTER_API_KEY: 'Standard OpenRouter key.',
    GEMINI_API_KEY: 'Standard key of the Gemini CLI FLUJO starts.',
    CODEX_API_KEY: 'Standard key of the Codex CLI FLUJO starts.',
    ANTIGRAVITY_CLI_HOME: 'Home folder of the Antigravity CLI FLUJO starts.',
  }),
  ...entries('test', {
    FLUJO_TEST_CLAUDE_SESSION_DIR: 'Tests keep Claude sessions in a temporary folder.',
    FLUJO_SYSTEM_KEY_STORE: 'Tests and CI never touch the real OS key store.',
    FLUJO_CODEX_APP_SERVER: 'Tests drive the Codex SDK path.',
    FLUJO_CODEX_AUTO_UPDATE: 'Acceptance and load runs pin the bundled Codex CLI so results stay reproducible offline.',
    FLUJO_TELEMETRY_URL: 'Acceptance and load runs send telemetry to a local stand-in.',
    FLUJO_TURN_TRACE_FILE: 'The flow-turn benchmark records per-turn timings.',
    FLUJO_MCP_WORKLOAD_TRACE: 'MCP smoke runs print workload checks.',
    FLUJO_BUNDLED_CONSENT_TRACE: 'Tests print bundled-server consent checks.',
    FLUJO_CHAT_ADMISSION_WAIT_MS: 'Tests shorten the chat admission wait.',
    FLUJO_CONVERSATION_CACHE_TTL_MS: 'Tests shorten the conversation cache lifetime.',
    FLUJO_CONVERSATION_CACHE_MAX_ENTRIES: 'Tests shrink the conversation cache.',
    FLUJO_CONVERSATION_CACHE_MAX_BYTES: 'Tests shrink the conversation cache.',
    FLUJO_MODEL_CATALOG_READER_IDLE_MS: 'Tests shorten the model catalog lease.',
    FLUJO_MODEL_CATALOG_WRITER_WAIT_MS: 'Tests shorten the model catalog writer wait.',
    FLUJO_WRITER_LEASE_IDLE_MS: 'Tests release the workspace writer lease at once.',
    FLUJO_OPERATIONS_RSS_BUDGET_BYTES: 'Tests set the memory budget the operations page reports against.',
    'FLUJO_RUN_ADMISSION_*': 'Tests and the run admission qualification shrink run limits.',
    FLUJO_SNAPSHOT_CAPTURE_TIMEOUT_MS: 'Tests shorten workspace snapshot capture.',
    FLUJO_SNAPSHOT_SESSION_TTL_MS: 'Tests shorten workspace snapshot sessions.',
    FLUJO_MIGRATION_VERBOSE: 'Migration tests show the real migration transcript.',
  }),
  ...entries('pending', {
    FLUJO_MCP_BOOT_CONCURRENCY: 'Read in services/mcp/index.ts; replaced by a machine-scaled value in the second #1449 pass.',
  }),
});
