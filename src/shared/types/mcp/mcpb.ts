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
 * What the bundle's signature (PKCS#7, appended by `mcpb sign`) proves:
 * - `signed`: the signature matches the file, and a certificate authority this
 *   computer trusts vouches for the signer.
 * - `invalid`: the file carries a signature that does not hold up. FLUJO
 *   refuses to install it; `problem` says why.
 * - `unsigned`: no signature, or a sound signature from a certificate no
 *   trusted authority vouches for (anyone can make one). Installing is allowed.
 */
export type McpbSignatureStatus = 'signed' | 'invalid' | 'unsigned';

export type McpbSignatureProblem =
  /** The signature block or the signature inside it cannot be read. */
  | 'damaged'
  /** The file was changed after it was signed. */
  | 'changed'
  /** The signature was not made with the certificate that comes with it. */
  | 'wrong-certificate'
  | 'expired'
  | 'not-yet-valid'
  /** The certificate may not be used to sign software. */
  | 'not-for-code-signing'
  /** An outdated or unknown signing method, such as SHA-1. */
  | 'unsupported-method';

/** Who the signing certificate names. Confirmed only when the status is `signed`. */
export interface McpbSigner {
  name: string;
  organization?: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** SHA-256 fingerprint of the signing certificate. */
  fingerprint: string;
}

export interface McpbSignature {
  status: McpbSignatureStatus;
  signer?: McpbSigner;
  problem?: McpbSignatureProblem;
}

/** Things the review screen points out. The browser words them. */
export type McpbReviewWarning =
  | 'secret-in-command-line'
  | 'runs-bundled-program'
  | 'installs-python-packages'
  | 'newer-format'
  | 'signer-changed';

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
  signature: McpbSignature;
  files: { count: number; packedBytes: number; unpackedBytes: number };
  suggestedServerName: string;
  /**
   * Set when this bundle is already installed: installing again upgrades it.
   * `signer` is who signed the installed version, when it was signed.
   */
  existing?: { serverName: string; version: string; signer?: string };
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
  | 'host-install-blocked'
  | 'invalid-signature';
