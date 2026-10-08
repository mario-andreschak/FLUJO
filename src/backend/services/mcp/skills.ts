import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_SKILLS_EXTENSION_ID,
  MCP_SKILLS_SUPPORTED_REVISION,
  type McpDirectoryResource,
  type McpGetSkillResult,
  type McpListSkillsResult,
  type McpLoadedSkill,
  type McpReadSkillDirectoryResult,
  type McpSkillEntry,
  type McpSkillResource,
  type McpSkillsExtensionCapability,
  type McpVerifiedSkillResource,
  McpGetSkillResultSchema,
  McpListSkillsResultSchema,
  McpReadSkillDirectoryResultSchema,
  normalizeMcpResourceUri,
  parseMcpSkillUri,
  validateMcpSkillsCapability,
} from "@/shared/types/mcp";

export type McpSkillsUnsupportedReason =
  | "disabled"
  | "extension-not-negotiated"
  | "method-not-found"
  | "directory-read-not-negotiated";

export class McpSkillsUnsupportedError extends Error {
  readonly reason: McpSkillsUnsupportedReason;

  constructor(reason: McpSkillsUnsupportedReason) {
    super(`MCP Skills are unavailable: ${reason}`);
    this.name = "McpSkillsUnsupportedError";
    this.reason = reason;
  }
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof McpError && error.code === -32601;
}

export function getMcpSkillsCapability(
  client: Client | undefined,
  enabled: boolean,
): McpSkillsExtensionCapability | undefined {
  if (!enabled || !client) return undefined;

  const capabilities = client.getServerCapabilities() as
    | { extensions?: Record<string, unknown> }
    | undefined;

  return validateMcpSkillsCapability(
    capabilities?.extensions?.[MCP_SKILLS_EXTENSION_ID],
  );
}

export function isMcpSkillsSupported(
  client: Client | undefined,
  enabled: boolean,
): boolean {
  return getMcpSkillsCapability(client, enabled) !== undefined;
}

function requireMcpSkillsCapability(
  client: Client | undefined,
  enabled: boolean,
): { client: Client; capability: McpSkillsExtensionCapability } {
  if (!enabled) throw new McpSkillsUnsupportedError("disabled");
  if (!client) {
    throw new McpSkillsUnsupportedError("extension-not-negotiated");
  }

  const capability = getMcpSkillsCapability(client, enabled);
  if (!capability) {
    throw new McpSkillsUnsupportedError("extension-not-negotiated");
  }
  return { client, capability };
}

async function requestSkills<T>(
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (isMethodNotFound(error)) {
      throw new McpSkillsUnsupportedError("method-not-found");
    }
    throw error;
  }
}

export async function listMcpSkills(
  client: Client | undefined,
  enabled: boolean,
  cursor?: string,
): Promise<McpListSkillsResult> {
  const supported = requireMcpSkillsCapability(client, enabled);

  return requestSkills(async () => {
    const result = await supported.client.request(
      {
        method: "skills/list",
        params: cursor === undefined ? {} : { cursor },
      } as never,
      McpListSkillsResultSchema,
    );
    return result as McpListSkillsResult;
  });
}

export async function getMcpSkill(
  client: Client | undefined,
  enabled: boolean,
  uri: string,
): Promise<McpGetSkillResult> {
  const supported = requireMcpSkillsCapability(client, enabled);
  const requestedUri = parseMcpSkillUri(uri).normalizedUri;

  return requestSkills(async () => {
    const result = (await supported.client.request(
      {
        method: "skills/get",
        params: { uri: requestedUri },
      } as never,
      McpGetSkillResultSchema,
    )) as McpGetSkillResult;

    if (result.skill.uri !== requestedUri) {
      throw new Error("skills/get returned a different skill URI");
    }
    return result;
  });
}

export async function readMcpSkillDirectory(
  client: Client | undefined,
  enabled: boolean,
  uri: string,
  cursor?: string,
): Promise<McpReadSkillDirectoryResult> {
  const supported = requireMcpSkillsCapability(client, enabled);
  if (supported.capability.directoryRead !== true) {
    throw new McpSkillsUnsupportedError("directory-read-not-negotiated");
  }

  const normalizedUri = normalizeMcpResourceUri(uri);
  return requestSkills(async () => {
    return (await supported.client.request(
      {
        method: "resources/directory/read",
        params: {
          uri: normalizedUri,
          ...(cursor === undefined ? {} : { cursor }),
        },
      } as never,
      McpReadSkillDirectoryResultSchema,
    )) as McpReadSkillDirectoryResult;
  });
}

function getDeclaredResource(
  entry: McpSkillEntry,
  resourceUri: string,
): McpSkillResource {
  if (entry.resources === "dynamic") {
    throw new Error("Dynamic MCP Skills cannot be integrity-verified");
  }

  const normalizedUri = normalizeMcpResourceUri(resourceUri);
  const resource = entry.resources.find((item) => item.uri === normalizedUri);
  if (!resource) {
    throw new Error("Resource is not declared by the held MCP Skill entry");
  }
  return resource;
}

function decodeBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("MCP Skill resource contains invalid base64");
  }
  return Buffer.from(value, "base64");
}

function resourceBytes(
  content: Record<string, unknown>,
): { bytes: Buffer; text?: string; blob?: string } {
  const hasText = typeof content.text === "string";
  const hasBlob = typeof content.blob === "string";
  if (hasText === hasBlob) {
    throw new Error("MCP Skill resource must contain exactly one of text or blob");
  }

  if (hasText) {
    return {
      bytes: Buffer.from(content.text as string, "utf8"),
      text: content.text as string,
    };
  }

  return {
    bytes: decodeBase64(content.blob as string),
    blob: content.blob as string,
  };
}

function assertManifestFrontmatter(
  text: string,
  entry: McpSkillEntry,
): void {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("MCP Skill SKILL.md must start with YAML frontmatter");
  }

  const closing = normalized.indexOf("\n---", 4);
  if (closing < 0) {
    throw new Error("MCP Skill SKILL.md frontmatter is not terminated");
  }

  const frontmatter = normalized.slice(4, closing);
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch {
    throw new Error("MCP Skill SKILL.md frontmatter is invalid YAML");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !isDeepStrictEqual(parsed, entry.frontmatter)
  ) {
    throw new Error(
      "MCP Skill SKILL.md frontmatter does not match its advertised entry",
    );
  }
}

export async function readVerifiedMcpSkillResource(
  client: Client | undefined,
  enabled: boolean,
  entry: McpSkillEntry,
  resourceUri: string,
): Promise<McpVerifiedSkillResource> {
  const supported = requireMcpSkillsCapability(client, enabled);
  const declared = getDeclaredResource(entry, resourceUri);
  const response = await supported.client.readResource({ uri: declared.uri });
  const contents = (response as { contents?: unknown }).contents;

  if (!Array.isArray(contents) || contents.length !== 1) {
    throw new Error("MCP Skill resource read must return exactly one content item");
  }

  const content = contents[0];
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("MCP Skill resource content is malformed");
  }

  const rawContent = content as Record<string, unknown>;
  if (
    rawContent.uri !== undefined &&
    normalizeMcpResourceUri(rawContent.uri) !== declared.uri
  ) {
    throw new Error("MCP Skill resource read returned a different URI");
  }

  const decoded = resourceBytes(rawContent);
  if (decoded.bytes.byteLength !== declared.size) {
    throw new Error("MCP Skill resource size verification failed");
  }

  const actualDigest = `sha256:${createHash("sha256")
    .update(decoded.bytes)
    .digest("hex")}`;
  if (actualDigest !== declared.digest) {
    throw new Error("MCP Skill resource digest verification failed");
  }

  return {
    uri: declared.uri,
    digest: declared.digest,
    size: declared.size,
    ...(typeof rawContent.mimeType === "string"
      ? { mimeType: rawContent.mimeType }
      : {}),
    ...decoded,
    verified: true,
  };
}

export async function loadVerifiedMcpSkill(
  client: Client | undefined,
  enabled: boolean,
  serverName: string,
  entry: McpSkillEntry,
): Promise<McpLoadedSkill> {
  if (entry.resources === "dynamic") {
    throw new Error("Dynamic MCP Skills cannot be integrity-verified");
  }

  const declaredResources = entry.resources;
  const resources = new Array<McpVerifiedSkillResource>(declaredResources.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= declaredResources.length) return;
      resources[index] = await readVerifiedMcpSkillResource(
        client,
        enabled,
        entry,
        declaredResources[index].uri,
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(4, declaredResources.length) },
      () => worker(),
    ),
  );

  const manifest = resources.find((resource) => resource.uri === entry.uri);
  if (!manifest || manifest.text === undefined) {
    throw new Error("MCP Skill SKILL.md must be textual content");
  }
  assertManifestFrontmatter(manifest.text, entry);

  return {
    identity: { serverName, skillUri: entry.uri },
    protocolRevision: MCP_SKILLS_SUPPORTED_REVISION,
    entry,
    manifest,
    resources,
    verification: "sha256",
    trust: "untrusted-external-content",
  };
}

export function filterDirectoryToHeldSkill(
  result: McpReadSkillDirectoryResult,
  entry: McpSkillEntry,
): McpReadSkillDirectoryResult {
  if (entry.resources === "dynamic") return result;

  const allowed = new Set(entry.resources.map((resource) => resource.uri));
  const resources = result.resources.filter(
    (resource: McpDirectoryResource) =>
      resource.mimeType === "inode/directory" || allowed.has(resource.uri),
  );

  return { ...result, resources };
}
