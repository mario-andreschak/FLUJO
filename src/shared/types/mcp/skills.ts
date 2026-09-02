import { z } from "zod/v4";

/**
 * Experimental MCP Skills transport types and validation.
 *
 * Frozen against SEP-2640 PR head a3e147ca2710f68214247aecc729731ee1ae8d03
 * (2026-08-29). Keep draft-specific wire details in this module.
 */
export const MCP_SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
export const MCP_SKILLS_SUPPORTED_REVISION =
  "SEP-2640@a3e147ca2710f68214247aecc729731ee1ae8d03";
export const MCP_SKILLS_MAX_RESOURCES = 512;
export const MCP_SKILLS_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const MCP_SKILLS_MAX_SELECTED_PER_TURN = 8;
export const MCP_SKILLS_MAX_CONTEXT_BYTES = 256 * 1024;

export type McpSkillDigest = `sha256:${string}`;

export interface McpSkillsExtensionCapability {
  directoryRead?: boolean;
}

export interface McpSkillFrontmatter {
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface McpSkillResource {
  uri: string;
  digest: McpSkillDigest;
  size: number;
}

export interface McpSkillEntry {
  uri: string;
  frontmatter: McpSkillFrontmatter;
  resources: McpSkillResource[] | "dynamic";
}

export interface McpListSkillsResult {
  [key: string]: unknown;
  resultType: "complete";
  skills: McpSkillEntry[];
  nextCursor?: string;
  ttlMs?: number;
  cacheScope?: "public" | "private";
}

export interface McpGetSkillResult {
  [key: string]: unknown;
  resultType: "complete";
  skill: McpSkillEntry;
  ttlMs?: number;
  cacheScope?: "public" | "private";
}

export type McpSkillsAvailability = "disabled" | "unsupported" | "available";

export interface McpServerSkillsResult extends McpListSkillsResult {
  serverName: string;
  availability: McpSkillsAvailability;
  capability?: McpSkillsExtensionCapability;
  error?: string;
}

export interface McpDirectoryResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpReadSkillDirectoryResult {
  [key: string]: unknown;
  resultType: "complete";
  resources: McpDirectoryResource[];
  nextCursor?: string;
  ttlMs?: number;
  cacheScope?: "public" | "private";
}

export interface McpServerQualifiedSkillIdentity {
  serverName: string;
  skillUri: string;
}

export interface ParsedMcpSkillUri {
  normalizedUri: string;
  rootUri: string;
  name: string;
  scheme: string;
}

export interface McpVerifiedSkillResource {
  uri: string;
  digest: McpSkillDigest;
  size: number;
  mimeType?: string;
  text?: string;
  blob?: string;
  verified: true;
}

export interface McpLoadedSkill {
  identity: McpServerQualifiedSkillIdentity;
  protocolRevision: typeof MCP_SKILLS_SUPPORTED_REVISION;
  entry: McpSkillEntry;
  manifest: McpVerifiedSkillResource;
  resources: McpVerifiedSkillResource[];
  verification: "sha256";
  trust: "untrusted-external-content";
}

/** Process-memory approval bound to one workspace conversation and manifest. */
export interface McpSkillApproval {
  workspace: string;
  conversationId: string;
  serverName: string;
  skillUri: string;
  manifestDigest: McpSkillDigest;
  approvedAt: number;
  expiresAt: number;
}

/** Bounded reference sent by Chat; content is reloaded and verified server-side. */
export interface McpSkillSelection {
  serverName: string;
  skillUri: string;
  manifestDigest: McpSkillDigest;
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class McpSkillsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSkillsValidationError";
  }
}

function fail(message: string): never {
  throw new McpSkillsValidationError(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateUriSegments(uri: URL, label: string): void {
  const segments = uri.pathname.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index === 0 && segment === "") continue;
    if (!segment) fail(`${label} contains an empty path segment`);

    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      fail(`${label} contains invalid percent encoding`);
    }

    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      fail(`${label} contains an unsafe path segment`);
    }
  }
}

export function normalizeMcpResourceUri(input: unknown): string {
  if (typeof input !== "string" || !input) {
    fail("resource URI must be a non-empty string");
  }
  if (input.includes("\\")) fail("resource URI must use forward slashes");

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    fail("resource URI must be an absolute URI");
  }

  if (
    !parsed.protocol ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    fail("resource URI must have no credentials, port, query, or fragment");
  }

  validateUriSegments(parsed, "resource URI");
  return parsed.href;
}

/**
 * Parses the URI of a skill's top-level SKILL.md.
 *
 * SEP-2640 recommends skill:// but permits server-native schemes, so the
 * validator enforces the hierarchical URI and SKILL.md structure rather than
 * privileging one scheme.
 */
export function parseMcpSkillUri(input: unknown): ParsedMcpSkillUri {
  const normalizedUri = normalizeMcpResourceUri(input);
  const parsed = new URL(normalizedUri);
  const pathSegments = parsed.pathname.split("/").filter(Boolean);

  if (pathSegments[pathSegments.length - 1] !== "SKILL.md") {
    fail("skill URI must identify a top-level SKILL.md");
  }

  const parentSegments = pathSegments.slice(0, -1);
  const encodedName =
    parentSegments.length > 0
      ? parentSegments[parentSegments.length - 1]
      : parsed.hostname;

  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    fail("skill URI contains an invalid name");
  }

  validateMcpSkillName(name);
  const rootUri = normalizedUri.slice(0, -"/SKILL.md".length);

  return {
    normalizedUri,
    rootUri,
    name,
    scheme: parsed.protocol.slice(0, -1),
  };
}

export function validateMcpSkillName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    !SKILL_NAME_PATTERN.test(value)
  ) {
    fail(
      "skill name must be 1-64 lowercase alphanumeric or hyphen characters without leading, trailing, or consecutive hyphens",
    );
  }
  return value;
}

export function validateMcpSkillDigest(value: unknown): McpSkillDigest {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("skill resource digest must be sha256 followed by 64 lowercase hex characters");
  }
  return value as McpSkillDigest;
}

function validateCacheFields(
  value: Record<string, unknown>,
): Pick<McpListSkillsResult, "ttlMs" | "cacheScope"> {
  const result: Pick<McpListSkillsResult, "ttlMs" | "cacheScope"> = {};

  if (value.ttlMs !== undefined) {
    if (
      typeof value.ttlMs !== "number" ||
      !Number.isInteger(value.ttlMs) ||
      value.ttlMs < 0
    ) {
      fail("ttlMs must be a non-negative integer");
    }
    result.ttlMs = value.ttlMs;
  }

  if (value.cacheScope !== undefined) {
    if (value.cacheScope !== "public" && value.cacheScope !== "private") {
      fail('cacheScope must be "public" or "private"');
    }
    result.cacheScope = value.cacheScope;
  }

  return result;
}

function validateFrontmatter(
  value: unknown,
  uriName: string,
): McpSkillFrontmatter {
  const frontmatter = asRecord(value, "skill frontmatter");
  const name = validateMcpSkillName(frontmatter.name);
  if (name !== uriName) {
    fail("skill frontmatter name must match the final skill path segment");
  }

  if (
    typeof frontmatter.description !== "string" ||
    frontmatter.description.length < 1 ||
    frontmatter.description.length > 1024
  ) {
    fail("skill description must be a non-empty string of at most 1024 characters");
  }

  return {
    ...frontmatter,
    name,
    description: frontmatter.description,
  };
}

export function validateMcpSkillEntry(value: unknown): McpSkillEntry {
  const entry = asRecord(value, "skill entry");
  const parsedUri = parseMcpSkillUri(entry.uri);
  const frontmatter = validateFrontmatter(entry.frontmatter, parsedUri.name);

  if (entry.resources === "dynamic") {
    return {
      uri: parsedUri.normalizedUri,
      frontmatter,
      resources: "dynamic",
    };
  }

  if (!Array.isArray(entry.resources)) {
    fail('skill resources must be a complete array or "dynamic"');
  }
  if (
    entry.resources.length < 1 ||
    entry.resources.length > MCP_SKILLS_MAX_RESOURCES
  ) {
    fail(
      `skill resources must contain 1-${MCP_SKILLS_MAX_RESOURCES} entries`,
    );
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  let hasManifest = false;

  const resources = entry.resources.map((rawResource, index) => {
    const resource = asRecord(rawResource, `skill resource ${index}`);
    const uri = normalizeMcpResourceUri(resource.uri);

    if (
      uri !== parsedUri.normalizedUri &&
      !uri.startsWith(`${parsedUri.rootUri}/`)
    ) {
      fail("skill resource URI must be contained within the skill root");
    }
    if (seen.has(uri)) fail("skill resource URIs must be unique");
    seen.add(uri);

    if (
      typeof resource.size !== "number" ||
      !Number.isSafeInteger(resource.size) ||
      resource.size < 0
    ) {
      fail("skill resource size must be a non-negative safe integer");
    }

    const digest = validateMcpSkillDigest(resource.digest);
    totalBytes += resource.size;
    if (totalBytes > MCP_SKILLS_MAX_TOTAL_BYTES) {
      fail(
        `skill resources exceed the ${MCP_SKILLS_MAX_TOTAL_BYTES}-byte limit`,
      );
    }

    if (uri === parsedUri.normalizedUri) hasManifest = true;
    return { uri, digest, size: resource.size };
  });

  if (!hasManifest) {
    fail("skill resources must include the top-level SKILL.md");
  }

  return {
    uri: parsedUri.normalizedUri,
    frontmatter,
    resources,
  };
}

export function validateMcpListSkillsResult(
  value: unknown,
): McpListSkillsResult {
  const result = asRecord(value, "skills/list result");
  if (result.resultType !== "complete") {
    fail('skills/list resultType must be "complete"');
  }
  if (!Array.isArray(result.skills)) {
    fail("skills/list skills must be an array");
  }
  if (
    result.nextCursor !== undefined &&
    typeof result.nextCursor !== "string"
  ) {
    fail("skills/list nextCursor must be a string");
  }

  const skills = result.skills.map(validateMcpSkillEntry);
  const seenSkillUris = new Set<string>();
  for (const skill of skills) {
    if (seenSkillUris.has(skill.uri)) {
      fail("skills/list skill URIs must be unique");
    }
    seenSkillUris.add(skill.uri);
  }

  return {
    resultType: "complete",
    skills,
    ...(result.nextCursor === undefined
      ? {}
      : { nextCursor: result.nextCursor }),
    ...validateCacheFields(result),
  };
}

export function validateMcpGetSkillResult(
  value: unknown,
): McpGetSkillResult {
  const result = asRecord(value, "skills/get result");
  if (result.resultType !== "complete") {
    fail('skills/get resultType must be "complete"');
  }

  return {
    resultType: "complete",
    skill: validateMcpSkillEntry(result.skill),
    ...validateCacheFields(result),
  };
}

export function validateMcpReadSkillDirectoryResult(
  value: unknown,
): McpReadSkillDirectoryResult {
  const result = asRecord(value, "resources/directory/read result");
  if (result.resultType !== "complete") {
    fail('resources/directory/read resultType must be "complete"');
  }
  if (!Array.isArray(result.resources)) {
    fail("resources/directory/read resources must be an array");
  }
  if (
    result.nextCursor !== undefined &&
    typeof result.nextCursor !== "string"
  ) {
    fail("resources/directory/read nextCursor must be a string");
  }

  const resources = result.resources.map((rawResource, index) => {
    const resource = asRecord(rawResource, `directory resource ${index}`);
    const uri = normalizeMcpResourceUri(resource.uri);
    if (typeof resource.name !== "string" || !resource.name) {
      fail("directory resource name must be a non-empty string");
    }
    if (
      resource.description !== undefined &&
      typeof resource.description !== "string"
    ) {
      fail("directory resource description must be a string");
    }
    if (
      resource.mimeType !== undefined &&
      typeof resource.mimeType !== "string"
    ) {
      fail("directory resource mimeType must be a string");
    }

    return {
      ...resource,
      uri,
      name: resource.name,
      ...(resource.description === undefined
        ? {}
        : { description: resource.description }),
      ...(resource.mimeType === undefined
        ? {}
        : { mimeType: resource.mimeType }),
    };
  });

  return {
    resultType: "complete",
    resources,
    ...(result.nextCursor === undefined
      ? {}
      : { nextCursor: result.nextCursor }),
    ...validateCacheFields(result),
  };
}

export function validateMcpSkillsCapability(
  value: unknown,
): McpSkillsExtensionCapability | undefined {
  if (value === undefined) return undefined;
  const capability = asRecord(value, "MCP Skills capability");
  if (
    capability.directoryRead !== undefined &&
    typeof capability.directoryRead !== "boolean"
  ) {
    fail("MCP Skills directoryRead capability must be boolean");
  }
  return capability.directoryRead === undefined
    ? {}
    : { directoryRead: capability.directoryRead };
}

export function mcpSkillCacheKey(
  serverName: string,
  skillUri: string,
  digest: McpSkillDigest,
): string {
  return JSON.stringify([serverName, parseMcpSkillUri(skillUri).normalizedUri, digest]);
}

/** Draft request schemas shared by client, proxy, and standalone adapters. */
export const McpListSkillsRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).optional(),
});

export const McpGetSkillRequestSchema = z.object({
  method: z.literal("skills/get"),
  params: z.object({ uri: z.string().min(1) }),
});

export const McpReadSkillDirectoryRequestSchema = z.object({
  method: z.literal("resources/directory/read"),
  params: z.object({ uri: z.string().min(1), cursor: z.string().optional() }),
});

export const McpListSkillsResultSchema = z
  .unknown()
  .transform((value) => validateMcpListSkillsResult(value));
export const McpGetSkillResultSchema = z
  .unknown()
  .transform((value) => validateMcpGetSkillResult(value));
export const McpReadSkillDirectoryResultSchema = z
  .unknown()
  .transform((value) => validateMcpReadSkillDirectoryResult(value));
