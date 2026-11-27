import type { MCPElicitationPolicy } from '@/shared/types/mcp';

/**
 * The one place that decides whether FLUJO offers an MCP client feature to a
 * server: MCP Apps, Skills over MCP and elicitation.
 *
 * Each feature is on unless the user turned it off for that server. A server
 * that runs under an isolation or host-trust policy keeps the switches exactly
 * as the person approved them, so there an unset switch means off.
 *
 * Read the switches only through these functions. `enableMcpApps === true` and
 * friends quietly turn an unset switch into "off" (lint rule
 * `flujo/mcp-feature-defaults`).
 */
export interface McpFeatureSwitches {
  enableMcpApps?: boolean;
  enableMcpSkills?: boolean;
  elicitation?: MCPElicitationPolicy;
  isolation?: unknown;
  trustedHost?: unknown;
}

function keepsApprovedSwitches(config: McpFeatureSwitches): boolean {
  return config.isolation !== undefined || config.trustedHost !== undefined;
}

function switchOn(value: boolean | undefined, config: McpFeatureSwitches): boolean {
  return keepsApprovedSwitches(config) ? value === true : value !== false;
}

/** MCP Apps: render a tool's `ui://` view in chat. */
export function mcpAppsEnabled(config: McpFeatureSwitches): boolean {
  return switchOn(config.enableMcpApps, config);
}

/** Skills over MCP: list a server's skills and let people and agents load them. */
export function mcpSkillsEnabled(config: McpFeatureSwitches): boolean {
  return switchOn(config.enableMcpSkills, config);
}

/** Elicitation: a server may ask the person for a form answer or to open a link. */
export function mcpElicitationEnabled(config: McpFeatureSwitches): boolean {
  return switchOn(config.elicitation?.enabled, config);
}

/**
 * The private sidecar runtime broker hands a sign-up token to a local process.
 * It is a FLUJO deployment extension, not part of MCP Apps, so it stays off
 * until someone turns MCP Apps on by hand.
 */
export function mcpAppRuntimeBrokerEnabled(config: McpFeatureSwitches): boolean {
  return config.enableMcpApps === true;
}
