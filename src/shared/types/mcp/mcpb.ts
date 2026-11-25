/**
 * MCP bundles (.mcpb, formerly .dxt): a zip file with a `manifest.json` that
 * describes one local MCP server (#1230). The browser sends the file, the
 * server reviews it, the person confirms, and only then FLUJO unpacks it into
 * `mcp-servers/mcpb/<server name>` and adds it as a local server.
 *
 * Format: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
 */

export type McpbServerType = 'node' | 'python' | 'binary' | 'uv';
export type McpbUserConfigType = 'string' | 'number' | 'boolean' | 'directory' | 'file';
export type McpbUserConfigValue = string | number | boolean | string[];
export type McpbPlatform = 'darwin' | 'win32' | 'linux';

/**
 * FLUJO reads the signature block but cannot check it yet, so a signed bundle
 * is treated like an unsigned one. `damaged` means the block is cut off.
 */
export type McpbSignatureStatus = 'unsigned' | 'signed-unverified' | 'damaged';

/** Things the review screen points out. The browser words them. */
export type McpbReviewWarning =
  | 'secret-in-command-line'
  | 'runs-bundled-program'
  | 'installs-python-packages'
  | 'newer-format'
  | 'signature-damaged';

export interface McpbUserConfigField {
  key: string;
  type: McpbUserConfigType;
  title: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  multiple: boolean;
  default?: McpbUserConfigValue;
  min?: number;
  max?: number;
  /** The value saved by the installed version (never for sensitive fields). */
  savedValue?: McpbUserConfigValue;
  /** A sensitive value is saved and is kept when the field is left empty. */
  hasSavedSecret?: boolean;
}

export interface McpbReview {
  /** SHA-256 of the exact file reviewed; the install must send it back. */
  digest: string;
  manifestName: string;
  displayName: string;
  version: string;
  manifestVersion: string;
  description: string;
  longDescription?: string;
  author: { name: string; email?: string; url?: string };
  license?: string;
  homepage?: string;
  repositoryUrl?: string;
  documentation?: string;
  support?: string;
  serverType: McpbServerType;
  /** What will run. `<bundle folder>` stands for the folder FLUJO unpacks into. */
  launch: { command: string; args: string[]; envNames: string[] };
  runtimes: { node?: string; python?: string };
  /** FLUJO's own Node.js version, which runs Node.js bundles. */
  flujoNodeVersion: string;
  /** Empty means the bundle says it works everywhere. */
  platforms: McpbPlatform[];
  thisPlatform: string;
  platformSupported: boolean;
  tools: Array<{ name: string; description?: string }>;
  toolsGenerated: boolean;
  prompts: Array<{ name: string; description?: string }>;
  promptsGenerated: boolean;
  privacyPolicies: string[];
  userConfig: McpbUserConfigField[];
  signature: { status: McpbSignatureStatus };
  files: { count: number; packedBytes: number; unpackedBytes: number };
  suggestedServerName: string;
  /** Set when this bundle is already installed: installing again upgrades it. */
  existing?: { serverName: string; version: string };
  warnings: McpbReviewWarning[];
}

export interface McpbInstallResult {
  installed: true;
  serverName: string;
  upgraded: boolean;
  version: string;
}

/** What the bundles route answers on failure. `code` lets the browser pick its words. */
export interface McpbErrorBody {
  error: string;
  code?: McpbErrorCode;
  /** For `missing-config`/`invalid-config`: the user_config keys at fault. */
  fields?: string[];
}

export type McpbErrorCode =
  | 'not-a-bundle'
  | 'invalid-manifest'
  | 'unsafe-path'
  | 'too-large'
  | 'disk-full'
  | 'wrong-platform'
  | 'unsupported-command'
  | 'missing-entry-point'
  | 'changed-since-review'
  | 'name-taken'
  | 'invalid-name'
  | 'missing-config'
  | 'invalid-config'
  | 'in-use'
  | 'host-install-blocked';
