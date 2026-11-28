// MCP Skills through the MCP service: capability checks, listing, reading and loading verified, approved skills.
import { mcpSkillsEnabled } from '@/shared/utils/mcpClientFeatures';
import { BundledFlujoWorkloadError } from '../security/bundledFlujoWorkload';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCP_APPS_EXTENSION_ID } from './appsProtocol';
import { isProtectedExecutionServer } from '@/backend/execution/extensions';
import {
  MCPServerConfig,
  MCPServiceResponse,
  MCP_SKILLS_EXTENSION_ID,
  parseMcpSkillUri,
  type McpGetSkillResult,
  type McpLoadedSkill,
  type McpReadSkillDirectoryResult,
  type McpServerSkillsResult,
  type McpSkillsExtensionCapability,
  type McpVerifiedSkillResource,
} from "@/shared/types/mcp";
import {
  McpSkillsUnsupportedError,
  getMcpSkill,
  getMcpSkillsCapability,
  listMcpSkills,
  loadVerifiedMcpSkill,
  readMcpSkillDirectory,
  readVerifiedMcpSkillResource,
} from "./skills";
import { getApprovedMcpSkill } from "./skillApprovalRegistry";
import { McpRuntimeAuthorityRetirementError } from "./connection";

/** What the skills functions use from the MCP service. */
export type McpSkillsHost = {
  getServerConfig(serverName: string): Promise<MCPServerConfig | null>;
  connectServer(serverName: string): Promise<MCPServiceResponse>;
  getClient(serverName: string): Client | undefined;
  forceReconnect(serverName: string): Promise<MCPServiceResponse>;
  getServerSkill(serverName: string, uri: string): Promise<MCPServiceResponse<McpGetSkillResult>>;
};

function mcpFailure<T>(response: MCPServiceResponse): MCPServiceResponse<T> {
  return {
    success: false,
    error: response.error,
    statusCode: response.statusCode,
    errorType: response.errorType,
  };
}


export async function prepareMcpSkillsClient(
  host: McpSkillsHost,
  serverName: string,
): Promise<MCPServiceResponse<{ client: Client; capability: McpSkillsExtensionCapability }>> {
  if (isProtectedExecutionServer(serverName)) return { success: false, error: 'execution_protocol_surface_forbidden' };
  const config = await host.getServerConfig(serverName);
  if (!config) {
    return { success: false, error: `MCP server '${serverName}' was not found.`, statusCode: 404 };
  }
  if (config.disabled) {
    return {
      success: false,
      error: `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`,
      statusCode: 409,
      errorType: "disabled",
    };
  }
  if (!mcpSkillsEnabled(config)) {
    return {
      success: false,
      error: `MCP Skills are disabled for server '${serverName}'.`,
      statusCode: 409,
      errorType: "skills_disabled",
    };
  }

  const connect = await host.connectServer(serverName);
  if (!connect.success) {
    return {
      success: false,
      error: connect.error || `Failed to connect to MCP server '${serverName}'.`,
      statusCode: connect.statusCode || 502,
    };
  }

  const client = host.getClient(serverName);
  const capability = getMcpSkillsCapability(client, true);
  if (!client || !capability) {
    return {
      success: false,
      error: `Server '${serverName}' does not advertise ${MCP_SKILLS_EXTENSION_ID}.`,
      statusCode: 404,
      errorType: "skills_unsupported",
    };
  }
  return { success: true, data: { client, capability } };
}

export async function getServerProxyCapabilities(host: McpSkillsHost, serverName: string): Promise<{
  skillsCapability?: McpSkillsExtensionCapability;
  appsCapability?: Record<string, unknown>;
}> {
  const config = await host.getServerConfig(serverName);
  if (!config || config.disabled) return {};
  const connect = await host.connectServer(serverName);
  if (!connect.success) return {};
  // Read both negotiated extensions from the same freshly checked connection.
  // There is no asynchronous work between these metadata reads.
  const client = host.getClient(serverName);
  const skillsCapability = getMcpSkillsCapability(
    client, mcpSkillsEnabled(config) && !isProtectedExecutionServer(serverName),
  );
  const capabilities = client?.getServerCapabilities() as
    | { extensions?: Record<string, unknown> }
    | undefined;
  const apps = capabilities?.extensions?.[MCP_APPS_EXTENSION_ID];
  const appsCapability = apps && typeof apps === 'object' && !Array.isArray(apps)
    ? { ...(apps as Record<string, unknown>) }
    : undefined;
  return { skillsCapability, appsCapability };
}

export async function getServerSkillsCapability(
  host: McpSkillsHost,
  serverName: string,
): Promise<McpSkillsExtensionCapability | undefined> {
  const prepared = await prepareMcpSkillsClient(host, serverName);
  return prepared.success ? prepared.data?.capability : undefined;
}

export async function listServerSkills(
  host: McpSkillsHost,
  serverName: string,
  cursor?: string,
): Promise<McpServerSkillsResult> {
  const config = await host.getServerConfig(serverName);
  if (!config || config.disabled || !mcpSkillsEnabled(config)) {
    return {
      resultType: "complete",
      skills: [],
      serverName,
      availability: "disabled",
      ...(!config ? { error: `MCP server '${serverName}' was not found.` } : {}),
    };
  }

  const prepared = await prepareMcpSkillsClient(host, serverName);
  if (!prepared.success || !prepared.data) {
    return {
      resultType: "complete",
      skills: [],
      serverName,
      availability:
        prepared.errorType === "skills_unsupported" ? "unsupported" : "available",
      ...(prepared.errorType === "skills_unsupported" ? {} : { error: prepared.error }),
    };
  }

  const attempt = async (client: Client) => listMcpSkills(client, true, cursor);
  try {
    const result = await attempt(prepared.data.client);
    return {
      ...result,
      serverName,
      availability: "available",
      capability: prepared.data.capability,
    };
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
    if (error instanceof McpSkillsUnsupportedError) {
      return {
        resultType: "complete",
        skills: [],
        serverName,
        availability: "unsupported",
      };
    }

    const reconnect = await host.forceReconnect(serverName);
    if (reconnect.success) {
      const retryClient = host.getClient(serverName);
      try {
        const result = await attempt(retryClient as Client);
        const capability = getMcpSkillsCapability(retryClient, true);
        return {
          ...result,
          serverName,
          availability: "available",
          ...(capability ? { capability } : {}),
        };
      } catch (retryError) {
        error = retryError;
      }
    }

    return {
      resultType: "complete",
      skills: [],
      serverName,
      availability: "available",
      error: error instanceof Error ? error.message : "Failed to list MCP Skills.",
    };
  }
}

export async function getServerSkill(
  host: McpSkillsHost,
  serverName: string,
  uri: string,
): Promise<MCPServiceResponse<McpGetSkillResult>> {
  const prepared = await prepareMcpSkillsClient(host, serverName);
  if (!prepared.success || !prepared.data) return mcpFailure(prepared);

  try {
    return { success: true, data: await getMcpSkill(prepared.data.client, true, uri) };
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get MCP Skill.",
      statusCode: error instanceof McpSkillsUnsupportedError ? 404 : 502,
    };
  }
}

export async function readServerSkillDirectory(
  host: McpSkillsHost,
  serverName: string,
  uri: string,
  cursor?: string,
): Promise<MCPServiceResponse<McpReadSkillDirectoryResult>> {
  const prepared = await prepareMcpSkillsClient(host, serverName);
  if (!prepared.success || !prepared.data) return mcpFailure(prepared);

  try {
    return {
      success: true,
      data: await readMcpSkillDirectory(prepared.data.client, true, uri, cursor),
    };
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to read MCP Skill directory.",
      statusCode: error instanceof McpSkillsUnsupportedError ? 404 : 502,
    };
  }
}

export async function readVerifiedSkillResource(
  host: McpSkillsHost,
  serverName: string,
  skillUri: string,
  resourceUri: string,
): Promise<MCPServiceResponse<McpVerifiedSkillResource>> {
  const prepared = await prepareMcpSkillsClient(host, serverName);
  if (!prepared.success || !prepared.data) return mcpFailure(prepared);
  const skill = await host.getServerSkill(serverName, skillUri);
  if (!skill.success || !skill.data) return mcpFailure(skill);

  try {
    return {
      success: true,
      data: await readVerifiedMcpSkillResource(
        prepared.data.client,
        true,
        skill.data.skill,
        resourceUri,
      ),
    };
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to verify MCP Skill resource.",
      statusCode: 422,
    };
  }
}

export async function loadVerifiedSkill(
  host: McpSkillsHost,
  serverName: string,
  skillUri: string,
  conversationId: string,
): Promise<MCPServiceResponse<McpLoadedSkill>> {
  const prepared = await prepareMcpSkillsClient(host, serverName);
  if (!prepared.success || !prepared.data) return mcpFailure(prepared);
  const skill = await host.getServerSkill(serverName, skillUri);
  if (!skill.success || !skill.data) return mcpFailure(skill);

  if (skill.data.skill.resources === "dynamic") {
    return {
      success: false,
      error: "Dynamic MCP Skills cannot be integrity-verified.",
      statusCode: 422,
    };
  }

  const normalizedSkillUri = parseMcpSkillUri(skill.data.skill.uri).normalizedUri;
  const manifest = skill.data.skill.resources.find(
    (resource) => resource.uri === normalizedSkillUri,
  );
  if (!manifest) {
    return {
      success: false,
      error: "MCP Skill manifest metadata is missing.",
      statusCode: 422,
    };
  }

  const approval = getApprovedMcpSkill({
    conversationId,
    serverName,
    skillUri: normalizedSkillUri,
    manifestDigest: manifest.digest,
  });
  if (!approval) {
    return {
      success: false,
      error: "This MCP Skill is not approved for the current conversation and manifest digest.",
      statusCode: 403,
      errorType: "skills_approval_required",
    };
  }

  try {
    return {
      success: true,
      data: await loadVerifiedMcpSkill(
        prepared.data.client,
        true,
        serverName,
        skill.data.skill,
      ),
    };
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to load MCP Skill.",
      statusCode: 422,
    };
  }
}
