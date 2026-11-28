// Static Authorization-header configs, and removing the OAuth scopes an old inference path left on them.
import { assertBundledFlujoWorkloadEffectCurrent, BundledFlujoWorkloadError } from '../security/bundledFlujoWorkload';
import { createLogger } from "@/utils/logger";
import { MCPServerConfig, MCPStreamableConfig, MCPSSEConfig, MCPServiceResponse } from "@/shared/types/mcp";
import { saveConfig } from "./config";
import { normalizeHeaderValue } from "@/utils/mcp/headers";
import { McpRuntimeAuthorityRetirementError } from "./connection";

const log = createLogger('backend/services/mcp/headerAuthScopes');

/** Whether a remote config explicitly selects static Authorization-header auth. */
export function hasConfiguredAuthorizationHeader(config: MCPServerConfig): boolean {
  if (config.transport !== "streamable" && config.transport !== "sse")
    return false;
  const headers = (config as MCPStreamableConfig | MCPSSEConfig).headers;
  if (!headers) return false;

  return Object.entries(headers).some(([key, raw]) => {
    if (key.toLowerCase() !== "authorization") return false;
    return normalizeHeaderValue(raw, key).value.trim().length > 0;
  });
}

/**
 * The legacy OAuth inference path persisted exactly this default. Restrict cleanup to that
 * signature so user-authored scope lists are never removed speculatively.
 */
function hasLegacyInferredOAuthScopes(config: MCPStreamableConfig): boolean {
  return config.oauthScopes?.length === 1 && config.oauthScopes[0] === "read";
}

/** Whether a config contains durable or in-progress FLUJO-managed OAuth state. */
function hasManagedOAuthState(config: MCPStreamableConfig): boolean {
  return !!(
    config.oauthClientId ||
    config.oauthClientSecret ||
    config.oauthClientMetadata ||
    config.oauthClientInformation ||
    config.oauthTokens ||
    config.oauthCodeVerifier ||
    config.oauthState ||
    config.authorizationUrl
  );
}


/**
 * Remove the exact stale marker written by the old auth-inference path once a static
 * Authorization header has proved it can establish a real connection. Reload from storage
 * before saving so resolved/decrypted connection material is never persisted accidentally.
 */
export async function clearLegacyInferredOAuthScopesForHeaderAuth(
  host: { loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse> },
  serverName: string,
): Promise<void> {
  try {
    const configs = await host.loadServerConfigs();
    if (!Array.isArray(configs)) return;

    const index = configs.findIndex((c) => c.name === serverName);
    if (index === -1 || configs[index].transport !== "streamable") return;

    const stored = configs[index] as MCPStreamableConfig;
    if (
      !hasConfiguredAuthorizationHeader(stored) ||
      !hasLegacyInferredOAuthScopes(stored) ||
      hasManagedOAuthState(stored)
    ) {
      return;
    }

    configs[index] = { ...stored, oauthScopes: undefined };
    await assertBundledFlujoWorkloadEffectCurrent();
    const result = await saveConfig(new Map(configs.map((c) => [c.name, c])));
    if (result.success) {
      log.info(
        `Removed stale inferred OAuth scopes from header-authenticated server ${serverName}`,
      );
    } else {
      log.warn(
        `Failed to remove stale inferred OAuth scopes from ${serverName}: ${result.error}`,
      );
    }
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
    // Cleanup is best-effort and must never turn a successful MCP connection into a failure.
    log.warn(
      `Failed to clean inferred OAuth scopes for ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
