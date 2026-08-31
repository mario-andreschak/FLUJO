import {
  type McpSkillEntry,
  normalizeMcpResourceUri,
  parseMcpSkillUri,
} from '@/shared/types/mcp';

export const FLUJO_STANDALONE_SKILL_SCHEME = 'skill+flujo:';

function encodeServerName(serverName: string): string {
  if (!serverName) throw new Error('A server name is required.');
  return Buffer.from(serverName, 'utf8').toString('hex');
}

function decodeServerName(token: string): string {
  if (!token || token.length % 2 !== 0 || !/^[0-9a-f]+$/.test(token)) {
    throw new Error('Invalid standalone Skill server identity.');
  }
  const value = Buffer.from(token, 'hex').toString('utf8');
  if (encodeServerName(value) !== token) {
    throw new Error('Invalid standalone Skill server identity.');
  }
  return value;
}

function encodeUri(uri: string): string {
  return Buffer.from(normalizeMcpResourceUri(uri), 'utf8').toString('base64url');
}

function decodeUri(token: string): string {
  if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Invalid standalone Skill URI identity.');
  }
  const value = Buffer.from(token, 'base64url').toString('utf8');
  if (Buffer.from(value, 'utf8').toString('base64url') !== token) {
    throw new Error('Invalid standalone Skill URI identity.');
  }
  return normalizeMcpResourceUri(value);
}

function standaloneRoot(serverName: string, entry: McpSkillEntry): string {
  return `${FLUJO_STANDALONE_SKILL_SCHEME}//${encodeServerName(serverName)}/${encodeUri(entry.uri)}/${entry.frontmatter.name}`;
}

export function rewriteMcpSkillEntryForStandalone(
  serverName: string,
  entry: McpSkillEntry,
): McpSkillEntry {
  const root = standaloneRoot(serverName, entry);
  const uri = `${root}/SKILL.md`;
  return {
    ...entry,
    uri,
    resources:
      entry.resources === 'dynamic'
        ? 'dynamic'
        : entry.resources.map((resource) => ({
            ...resource,
            uri:
              resource.uri === entry.uri
                ? uri
                : `${root}/resources/${encodeUri(resource.uri)}`,
          })),
  };
}

export interface DecodedStandaloneSkillResource {
  serverName: string;
  skillUri: string;
  resourceUri: string;
  transportUri: string;
}

export function decodeStandaloneSkillResource(
  input: string,
): DecodedStandaloneSkillResource {
  const transportUri = normalizeMcpResourceUri(input);
  const parsed = new URL(transportUri);
  if (parsed.protocol !== FLUJO_STANDALONE_SKILL_SCHEME) {
    throw new Error('Not a standalone MCP Skill URI.');
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 3) {
    throw new Error('Malformed standalone MCP Skill URI.');
  }

  const serverName = decodeServerName(parsed.hostname);
  const skillUri = parseMcpSkillUri(decodeUri(segments[0])).normalizedUri;
  const skillName = parseMcpSkillUri(skillUri).name;
  if (decodeURIComponent(segments[1]) !== skillName) {
    throw new Error('Standalone MCP Skill name does not match its source URI.');
  }

  let resourceUri: string;
  if (segments.length === 3 && segments[2] === 'SKILL.md') {
    resourceUri = skillUri;
  } else if (
    segments.length === 4 &&
    segments[2] === 'resources'
  ) {
    resourceUri = decodeUri(segments[3]);
  } else {
    throw new Error('Malformed standalone MCP Skill resource URI.');
  }

  return { serverName, skillUri, resourceUri, transportUri };
}
