// What an MCP server config save writes: encrypted secrets, kept masked values, and the managed root folder.
import { BundledFlujoWorkloadError } from '../security/bundledFlujoWorkload';
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/utils/logger";
import { getWorkspaceDataDir } from "@/utils/workspace";
import { shippedDescriptorForConfig } from './shippedServers';
import { MCPServerConfig, MCPHeaderValue, EnvVarValue } from "@/shared/types/mcp";
import { encryptApiKey } from "@/backend/services/model/encryption";
import { isSecretEnvVar } from "@/utils/shared/common";
import { mcpValueRecord } from "@/utils/mcp/values";
import { normalizeHeaderValue, isMaskedHeaderValue, isGlobalBinding } from "@/utils/mcp/headers";
import { McpRuntimeAuthorityRetirementError } from "./connection";

const log = createLogger('backend/services/mcp/serverConfigSave');

/**
 * Decide what to persist for a streamable server's OAuth client secret, given the value the
 * browser sent and the currently-stored value. Same contract as the model service's
 * API-key handling so the two behave identically:
 *   - MASKED_API_KEY        -> keep the existing stored secret (the UI never saw the real one)
 *   - "${global:VAR}"       -> a global-variable binding; store the reference verbatim
 *   - "encrypted:"         -> already encrypted; store as-is (idempotent, no double-encrypt)
 *   - "" (empty)            -> cleared/unbound; store empty
 *   - anything else         -> a freshly typed plaintext secret; encrypt it at rest
 */
export async function resolveOAuthSecretForSave(
  incoming: string,
  existing: string | undefined,
): Promise<string> {
  if (isMaskedHeaderValue(incoming)) incoming = existing ?? "";
  if (!incoming) return "";
  if (incoming.startsWith("${global:")) return incoming;
  return encryptSecretForSave(incoming);
}

/** Never persist the legacy encryption-failure marker, which contains plaintext. */
export async function encryptSecretForSave(value: string): Promise<string> {
  if (value.startsWith("encrypted_failed:")) {
    throw new Error("MCP credential encryption failed");
  }
  if (value.startsWith("encrypted:") && value.length > "encrypted:".length) {
    return value;
  }
  const encrypted = await encryptApiKey(value);
  if (!encrypted.startsWith("encrypted:") || encrypted.length <= "encrypted:".length) {
    throw new Error("MCP credential encryption failed");
  }
  return encrypted;
}

/** Env maps replace the prior map; explicit masks retain secrets, omitted keys delete them. */
export async function resolveEnvForSave(
  incoming: Record<string, EnvVarValue>,
  existing: Record<string, EnvVarValue> | undefined,
): Promise<Record<string, EnvVarValue>> {
  const result: Record<string, EnvVarValue> = {};
  for (const [key, raw] of Object.entries(mcpValueRecord(incoming))) {
    let value = typeof raw === "string" ? raw : raw.value;
    const previous = existing?.[key];
    const wasSecret = typeof previous === "object" && previous.metadata.isSecret;
    const isSecret = typeof raw === "string"
      ? wasSecret || isSecretEnvVar(key)
      : raw.metadata.isSecret;
    if (!isSecret) {
      result[key] = raw;
      continue;
    }
    if (isMaskedHeaderValue(value)) {
      if (previous === undefined) continue;
      value = typeof previous === "string" ? previous : previous.value;
      // A placeholder without a stored credential must never become a runtime password.
      if (isMaskedHeaderValue(value)) continue;
    }
    result[key] = {
      value: !value || isGlobalBinding(value) ? value : await encryptSecretForSave(value),
      metadata: { isSecret: true },
    };
  }
  return result;
}

/**
 * Decide what to persist for a remote server's custom HTTP headers (#84), given the header
 * map the browser sent and the currently-stored map. Non-secret headers are stored verbatim.
 * Secret headers follow the same contract as the OAuth client secret / model API keys so
 * they behave identically:
 *   - MASKED_API_KEY / MASKED_STRING -> keep the existing stored value (UI never saw the real one)
 *   - "${global:VAR}"                -> a global-variable binding; store the reference verbatim
 *   - "encrypted:"                  -> already encrypted; store as-is (no double-encrypt)
 *   - "" (empty)                     -> cleared; drop the header
 *   - anything else                  -> a freshly typed plaintext secret; encrypt it at rest
 */
export async function resolveHeadersForSave(
  incoming: Record<string, MCPHeaderValue>,
  existing: Record<string, MCPHeaderValue> | undefined,
): Promise<Record<string, MCPHeaderValue>> {
  const result: Record<string, MCPHeaderValue> = {};
  for (const [key, raw] of Object.entries(incoming || {})) {
    if (!key) continue;
    let { value } = normalizeHeaderValue(raw, key);
    const { isSecret } = normalizeHeaderValue(raw, key);

    if (!isSecret) {
      // Non-secret header: store verbatim (drop empties). Keep the object shape so the
      // per-header secret flag round-trips.
      if (value !== "") {
        result[key] = { value, metadata: { isSecret: false } };
      }
      continue;
    }

    // Secret header handling, mirroring resolveOAuthSecretForSave.
    if (isMaskedHeaderValue(value)) {
      const prev = existing?.[key];
      if (prev === undefined) continue;
      value = normalizeHeaderValue(prev, key).value;
      if (isMaskedHeaderValue(value)) continue;
    }
    if (!value) continue; // cleared
    if (isGlobalBinding(value)) {
      result[key] = { value, metadata: { isSecret: true } };
      continue;
    }
    result[key] = {
      value: await encryptSecretForSave(value),
      metadata: { isSecret: true },
    };
  }
  return result;
}

/**
 * Eagerly create managed roots that have no clone/install step: remote servers
 * (issue 52) and Registry stdio packages executed by npx/uvx/etc. Registry package
 * processes launch from a separate private runtime cwd, but roots/list and file
 * pickers still need their mcp-servers/<name> directory to exist.
 * Best-effort — failures are logged, never thrown.
 */
export async function ensureManagedServerRootDir(
  config: MCPServerConfig,
): Promise<void> {
  try {
    const rootPath = (config.rootPath || "").trim();
    if (!rootPath) return;
    const isRemote = ["streamable", "sse", "websocket"].includes(config.transport);
    const isRegistryPackage =
      config.transport === "stdio"
      && (config.source?.type === "registry" || config.source?.type === "marketplace");
    if (!isRemote && !isRegistryPackage) return;

    const resolved = path.resolve(getWorkspaceDataDir(), rootPath);
    // Never create (or touch) a filesystem root — a root is its own parent.
    if (path.dirname(resolved) === resolved) return;
    const shipped = config.transport === 'stdio' ? shippedDescriptorForConfig(config) : undefined;
    if (shipped && resolved === path.resolve(getWorkspaceDataDir(), 'mcp-servers', shipped.packageDirectory)) {
      // Shipped marketplace records have a clone step at transport start.
      // Creating an empty destination here would make that step treat it as
      // an existing package and reject its missing manifest. Leave both new
      // and existing reserved directories to the strict package copier.
      return;
    }
    if (isRegistryPackage) {
      // Registry stdio roots are FLUJO-managed. Refuse an unexpected absolute or
      // traversing value even if a malformed config reaches this boundary.
      const managedRoot = path.join(getWorkspaceDataDir(), "mcp-servers");
      const relative = path.relative(managedRoot, resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
    }
    await fs.mkdir(resolved, { recursive: true });
    log.debug(
      `ensureManagedServerRootDir: ensured ${resolved} for ${config.name}`,
    );
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
    log.warn(
      `ensureManagedServerRootDir: could not create root dir for ${config.name}:`,
      error,
    );
  }
}
