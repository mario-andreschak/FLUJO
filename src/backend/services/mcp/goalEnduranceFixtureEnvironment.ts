import path from 'path';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { trustedHostMcpPolicySchema } from '../security/trustedHostMcp';

export const GOAL_ENDURANCE_FIXTURE_TOKEN_ENV =
  'PERSONA_GOAL_ENDURANCE_FIXTURE_TOKEN';

const FIXTURE_PROFILE_ENV = 'PERSONA_GOAL_ENDURANCE_PROFILE';
const FIXTURE_URL_ENV = 'PERSONA_GOAL_ENDURANCE_FIXTURE_URL';
const FIXTURE_AGENT_ROOT_ENV = 'PERSONA_GOAL_ENDURANCE_AGENT_ROOT';
const FIXTURE_RUN_ID_ENV = 'PERSONA_GOAL_ENDURANCE_RUN_ID';
export const FIXTURE_ENTRY_ENV = 'PERSONA_GOAL_ENDURANCE_FIXTURE_ENTRY';
export const FIXTURE_SOURCE_DIGEST_ENV = 'PERSONA_GOAL_ENDURANCE_FIXTURE_SOURCE_DIGEST';
const SUPPORTED_PROFILE = 'structured-tools';
const FIXTURE_SERVER_NAME = 'goal-endurance';
const FIXTURE_SCRIPT = path.join(
  'scripts',
  'persona-goal-acceptance',
  'public-fixture-mcp.mjs',
);

type ProcessEnvironment = Readonly<Record<string, string | undefined>>;

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

/**
 * Select the endurance fixture authorization at runtime without adding it to
 * the persisted MCP config. Every runner-owned binding must match the exact
 * controlled fixture launch before the token is released to the child.
 */
export function resolveGoalEnduranceFixtureToken(
  config: MCPServerConfig,
  env: ProcessEnvironment = process.env,
): string | undefined {
  if (
    config.transport !== 'stdio' ||
    config.disabled ||
    config.name !== FIXTURE_SERVER_NAME ||
    config.source?.type !== 'local' ||
    env[FIXTURE_PROFILE_ENV] !== SUPPORTED_PROFILE ||
    !config.rootPath ||
    !samePath(config.rootPath, process.cwd()) ||
    !samePath(config.command, process.execPath)
  ) {
    return undefined;
  }

  const args = config.args ?? [];
  // A staged package requires runner-owned revision and entry bindings in
  // addition to the separately protected host grant checked at launch.
  const parsedPolicy = config.trustedHost === undefined ? undefined : trustedHostMcpPolicySchema.safeParse(config.trustedHost);
  if (parsedPolicy && !parsedPolicy.success) return undefined;
  const policy = parsedPolicy?.success ? parsedPolicy.data : undefined;
  const stagedEntry = env[FIXTURE_ENTRY_ENV];
  if (policy && (!stagedEntry || !path.isAbsolute(stagedEntry)
      || !samePath(policy.entryPoint, stagedEntry)
      || !env[FIXTURE_SOURCE_DIGEST_ENV]
      || policy.sourceDigest !== env[FIXTURE_SOURCE_DIGEST_ENV])) return undefined;
  const expectedScript = policy ? stagedEntry! : path.resolve(process.cwd(), FIXTURE_SCRIPT);
  if (args.length !== 4 || !samePath(args[0], expectedScript)) {
    return undefined;
  }

  const fixtureUrl = env[FIXTURE_URL_ENV];
  const agentRoot = env[FIXTURE_AGENT_ROOT_ENV];
  const runId = env[FIXTURE_RUN_ID_ENV];
  if (
    !fixtureUrl?.trim() ||
    !agentRoot?.trim() ||
    !runId?.trim() ||
    args[1] !== fixtureUrl ||
    args[2] !== agentRoot ||
    args[3] !== runId
  ) {
    return undefined;
  }

  const token = env[GOAL_ENDURANCE_FIXTURE_TOKEN_ENV];
  return token?.trim() ? token : undefined;
}
