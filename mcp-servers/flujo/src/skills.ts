import { z } from 'zod/v4';

/**
 * Experimental MCP Skills wire contract used by the standalone FLUJO server.
 *
 * Keep this package-local definition in sync with
 * src/shared/types/mcp/skills.ts. The standalone package is published on its
 * own and cannot import source files from the parent application.
 */
export const MCP_SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

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

/** Draft request schemas frozen to the Skills protocol implemented by FLUJO. */
export const McpListSkillsRequestSchema = z.object({
  method: z.literal('skills/list'),
  params: z.object({ cursor: z.string().optional() }).optional(),
});

export const McpGetSkillRequestSchema = z.object({
  method: z.literal('skills/get'),
  params: z.object({ uri: z.string().min(1) }),
});
