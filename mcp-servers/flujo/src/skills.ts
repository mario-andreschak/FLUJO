import { z } from 'zod/v4';

/**
 * Experimental MCP Skills wire contract used by the standalone FLUJO server.
 * Frozen to the same SEP revision and validation limits as the host adapter.
 */
export const MCP_SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';
export const MCP_SKILLS_SUPPORTED_REVISION =
  'SEP-2640@a3e147ca2710f68214247aecc729731ee1ae8d03';
export const MCP_SKILLS_MAX_RESOURCES = 512;
export const MCP_SKILLS_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export type StandaloneSkillDigest = `sha256:${string}`;

export interface StandaloneSkillFrontmatter {
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface StandaloneSkillResource {
  uri: string;
  digest: StandaloneSkillDigest;
  size: number;
}

export interface StandaloneSkillEntry {
  uri: string;
  frontmatter: StandaloneSkillFrontmatter;
  resources: StandaloneSkillResource[] | 'dynamic';
}

export interface StandaloneListSkillsResult {
  [key: string]: unknown;
  resultType: 'complete';
  skills: StandaloneSkillEntry[];
  nextCursor?: string;
  ttlMs?: number;
  cacheScope?: 'public' | 'private';
}

export interface StandaloneGetSkillResult {
  [key: string]: unknown;
  resultType: 'complete';
  skill: StandaloneSkillEntry;
  ttlMs?: number;
  cacheScope?: 'public' | 'private';
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class StandaloneSkillsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandaloneSkillsValidationError';
  }
}

function fail(message: string): never {
  throw new StandaloneSkillsValidationError(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateUriSegments(uri: URL, label: string): void {
  const segments = uri.pathname.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index === 0 && segment === '') continue;
    if (!segment) fail(`${label} contains an empty path segment`);

    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      fail(`${label} contains invalid percent encoding`);
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\')
    ) {
      fail(`${label} contains an unsafe path segment`);
    }
  }
}

function normalizeResourceUri(input: unknown): string {
  if (typeof input !== 'string' || !input) {
    fail('resource URI must be a non-empty string');
  }
  if (input.includes('\\')) fail('resource URI must use forward slashes');

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    fail('resource URI must be an absolute URI');
  }
  if (
    !parsed.protocol ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    fail('resource URI must have no credentials, port, query, or fragment');
  }
  validateUriSegments(parsed, 'resource URI');
  return parsed.href;
}

function validateSkillName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    !SKILL_NAME_PATTERN.test(value)
  ) {
    fail(
      'skill name must be 1-64 lowercase alphanumeric or hyphen characters without leading, trailing, or consecutive hyphens',
    );
  }
  return value;
}

function parseSkillUri(input: unknown): {
  normalizedUri: string;
  rootUri: string;
  name: string;
} {
  const normalizedUri = normalizeResourceUri(input);
  const parsed = new URL(normalizedUri);
  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  if (pathSegments[pathSegments.length - 1] !== 'SKILL.md') {
    fail('skill URI must identify a top-level SKILL.md');
  }

  const parentSegments = pathSegments.slice(0, -1);
  const encodedName = parentSegments.length
    ? parentSegments[parentSegments.length - 1]
    : parsed.hostname;
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    fail('skill URI contains an invalid name');
  }
  validateSkillName(name);
  return {
    normalizedUri,
    rootUri: normalizedUri.slice(0, -'/SKILL.md'.length),
    name,
  };
}

function validateDigest(value: unknown): StandaloneSkillDigest {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('skill resource digest must be sha256 followed by 64 lowercase hex characters');
  }
  return value as StandaloneSkillDigest;
}

function validateCacheFields(
  value: Record<string, unknown>,
): Pick<StandaloneListSkillsResult, 'ttlMs' | 'cacheScope'> {
  const result: Pick<StandaloneListSkillsResult, 'ttlMs' | 'cacheScope'> = {};
  if (value.ttlMs !== undefined) {
    if (
      typeof value.ttlMs !== 'number' ||
      !Number.isInteger(value.ttlMs) ||
      value.ttlMs < 0
    ) {
      fail('ttlMs must be a non-negative integer');
    }
    result.ttlMs = value.ttlMs;
  }
  if (value.cacheScope !== undefined) {
    if (value.cacheScope !== 'public' && value.cacheScope !== 'private') {
      fail('cacheScope must be "public" or "private"');
    }
    result.cacheScope = value.cacheScope;
  }
  return result;
}

export function validateStandaloneSkillEntry(
  value: unknown,
): StandaloneSkillEntry {
  const entry = asRecord(value, 'skill entry');
  const parsedUri = parseSkillUri(entry.uri);
  const rawFrontmatter = asRecord(entry.frontmatter, 'skill frontmatter');
  const name = validateSkillName(rawFrontmatter.name);
  if (name !== parsedUri.name) {
    fail('skill frontmatter name must match the final skill path segment');
  }
  if (
    typeof rawFrontmatter.description !== 'string' ||
    rawFrontmatter.description.length < 1 ||
    rawFrontmatter.description.length > 1024
  ) {
    fail('skill description must be a non-empty string of at most 1024 characters');
  }
  const frontmatter: StandaloneSkillFrontmatter = {
    ...rawFrontmatter,
    name,
    description: rawFrontmatter.description,
  };

  if (entry.resources === 'dynamic') {
    return { uri: parsedUri.normalizedUri, frontmatter, resources: 'dynamic' };
  }
  if (!Array.isArray(entry.resources)) {
    fail('skill resources must be a complete array or "dynamic"');
  }
  if (
    entry.resources.length < 1 ||
    entry.resources.length > MCP_SKILLS_MAX_RESOURCES
  ) {
    fail(`skill resources must contain 1-${MCP_SKILLS_MAX_RESOURCES} entries`);
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  let hasManifest = false;
  const resources = entry.resources.map((rawResource, index) => {
    const resource = asRecord(rawResource, `skill resource ${index}`);
    const uri = normalizeResourceUri(resource.uri);
    if (
      uri !== parsedUri.normalizedUri &&
      !uri.startsWith(`${parsedUri.rootUri}/`)
    ) {
      fail('skill resource URI must be contained within the skill root');
    }
    if (seen.has(uri)) fail('skill resource URIs must be unique');
    seen.add(uri);

    if (
      typeof resource.size !== 'number' ||
      !Number.isSafeInteger(resource.size) ||
      resource.size < 0
    ) {
      fail('skill resource size must be a non-negative safe integer');
    }
    const digest = validateDigest(resource.digest);
    totalBytes += resource.size;
    if (totalBytes > MCP_SKILLS_MAX_TOTAL_BYTES) {
      fail(`skill resources exceed the ${MCP_SKILLS_MAX_TOTAL_BYTES}-byte limit`);
    }
    if (uri === parsedUri.normalizedUri) hasManifest = true;
    return { uri, digest, size: resource.size };
  });

  if (!hasManifest) {
    fail('skill resources must include the top-level SKILL.md');
  }
  return { uri: parsedUri.normalizedUri, frontmatter, resources };
}

export function validateStandaloneListSkillsResult(
  value: unknown,
): StandaloneListSkillsResult {
  const result = asRecord(value, 'skills/list result');
  if (result.resultType !== 'complete') {
    fail('skills/list resultType must be "complete"');
  }
  if (!Array.isArray(result.skills)) {
    fail('skills/list skills must be an array');
  }
  if (
    result.nextCursor !== undefined &&
    typeof result.nextCursor !== 'string'
  ) {
    fail('skills/list nextCursor must be a string');
  }

  const skills = result.skills.map(validateStandaloneSkillEntry);
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.uri)) fail('skills/list skill URIs must be unique');
    seen.add(skill.uri);
  }
  return {
    resultType: 'complete',
    skills,
    ...(result.nextCursor === undefined
      ? {}
      : { nextCursor: result.nextCursor }),
    ...validateCacheFields(result),
  };
}

export function validateStandaloneGetSkillResult(
  value: unknown,
): StandaloneGetSkillResult {
  const result = asRecord(value, 'skills/get result');
  if (result.resultType !== 'complete') {
    fail('skills/get resultType must be "complete"');
  }
  return {
    resultType: 'complete',
    skill: validateStandaloneSkillEntry(result.skill),
    ...validateCacheFields(result),
  };
}

/** Draft request schemas frozen to the Skills protocol implemented by FLUJO. */
export const McpListSkillsRequestSchema = z.object({
  method: z.literal('skills/list'),
  params: z.object({ cursor: z.string().optional() }).optional(),
});

export const McpGetSkillRequestSchema = z.object({
  method: z.literal('skills/get'),
  params: z.object({ uri: z.string().min(1) }),
});

export const McpListSkillsResultSchema = z
  .unknown()
  .transform(validateStandaloneListSkillsResult);

export const McpGetSkillResultSchema = z
  .unknown()
  .transform(validateStandaloneGetSkillResult);
