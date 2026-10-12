import { withWorkspaceRoute } from '@/app/api/_workspace';
import type { NextRequest } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { mcpService } from '@/backend/services/mcp';
import {
  decodeStandaloneSkillResource,
  rewriteMcpSkillEntryForStandalone,
} from '@/backend/services/mcp/standaloneSkills';
import { json } from '@/app/api/mcp/_helpers';
import { McpListSkillsResultSchema } from '@/shared/types/mcp';
import { assertBundledFlujoWorkloadAction, BundledFlujoWorkloadError } from '@/backend/services/security/bundledFlujoWorkload';

const MAX_STANDALONE_SKILLS = 1024;
const MAX_PAGES_PER_SERVER = 128;

async function GET_handler() {
  const lock = await assertUnlocked();
  if (lock) return lock;

  await assertBundledFlujoWorkloadAction('listSkills', 'GET', '/api/mcp/flujo/skills');
  const configs = await mcpService.loadServerConfigs();
  if (!Array.isArray(configs)) {
    return json({ error: configs.error || 'Failed to load MCP server configurations.' }, 500);
  }

  const skills = [];
  for (const config of configs) {
    if (config.disabled || config.enableMcpSkills !== true) continue;

    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_PAGES_PER_SERVER; page += 1) {
      await assertBundledFlujoWorkloadAction('listSkills', 'GET', '/api/mcp/flujo/skills');
      const result = await mcpService.listServerSkills(config.name, cursor);
      await assertBundledFlujoWorkloadAction('listSkills', 'GET', '/api/mcp/flujo/skills');
      if (result.availability === 'unsupported') break;
      if (result.error) return json({ error: result.error }, 502);

      for (const entry of result.skills) {
        skills.push(rewriteMcpSkillEntryForStandalone(config.name, entry));
        if (skills.length > MAX_STANDALONE_SKILLS) {
          return json({ error: 'The standalone MCP Skill catalog exceeds its safety limit.' }, 413);
        }
      }

      if (!result.nextCursor) break;
      if (seenCursors.has(result.nextCursor)) {
        return json({ error: 'A downstream MCP Skill catalog repeated its pagination cursor.' }, 502);
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;

      if (page === MAX_PAGES_PER_SERVER - 1) {
        return json({ error: 'A downstream MCP Skill catalog exceeded its page limit.' }, 413);
      }
    }
  }

  try {
    await assertBundledFlujoWorkloadAction('listSkills', 'GET', '/api/mcp/flujo/skills');
    return json(
      McpListSkillsResultSchema.parse({ resultType: 'complete', skills }),
      200,
    );
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError) return error.response;
    return json(
      {
        error: error instanceof Error
          ? error.message
          : 'The standalone MCP Skill catalog is malformed.',
      },
      502,
    );
  }
}

async function POST_handler(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  let body: { uri?: unknown };
  try {
    body = (await request.json()) as { uri?: unknown };
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }

  const uri = typeof body.uri === 'string' ? body.uri.trim() : '';
  if (!uri) return json({ error: 'A standalone Skill URI is required.' }, 400);

  try {
    const decoded = decodeStandaloneSkillResource(uri);
    if (decoded.resourceUri !== decoded.skillUri) {
      return json({ error: 'skills/get requires a top-level SKILL.md URI.' }, 400);
    }
    await assertBundledFlujoWorkloadAction('getSkill', 'POST', '/api/mcp/flujo/skills', { uri });
    const result = await mcpService.getServerSkill(decoded.serverName, decoded.skillUri);
    await assertBundledFlujoWorkloadAction('getSkill', 'POST', '/api/mcp/flujo/skills', { uri });
    if (!result.success || !result.data) {
      return json({ error: result.error || 'MCP Skill not found.' }, result.statusCode || 502);
    }
    const skill = rewriteMcpSkillEntryForStandalone(
      decoded.serverName,
      result.data.skill,
    );
    if (skill.uri !== decoded.transportUri) {
      return json({ error: 'Standalone Skill identity did not match its source.' }, 400);
    }
    return json({
      ...result.data,
      skill,
    }, 200);
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError) return error.response;
    return json(
      { error: error instanceof Error ? error.message : 'Invalid standalone Skill URI.' },
      400,
    );
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
