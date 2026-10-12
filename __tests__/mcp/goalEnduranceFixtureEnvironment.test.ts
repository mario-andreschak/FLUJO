import path from 'path';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { resolveStdioLaunch } from '@/backend/services/mcp/connection';
import { installTrustedHostProfile } from './fixtures/trustedHostProfile';
import { trustedHostMcpPolicySchema } from '@/backend/services/security/trustedHostMcp';
import {
  GOAL_ENDURANCE_FIXTURE_TOKEN_ENV,
  resolveGoalEnduranceFixtureToken,
} from '@/backend/services/mcp/goalEnduranceFixtureEnvironment';

const token = 'synthetic-endurance-fixture-token';
const fixtureUrl = 'http://127.0.0.1:43123';
const agentRoot = path.resolve('test-outputs', 'goal-endurance-agent');
const runId = 'goal-endurance-runtime-env-test';

const runnerEnv: Record<string, string | undefined> = {
  PERSONA_GOAL_ENDURANCE_PROFILE: 'structured-tools',
  PERSONA_GOAL_ENDURANCE_FIXTURE_URL: fixtureUrl,
  PERSONA_GOAL_ENDURANCE_AGENT_ROOT: agentRoot,
  PERSONA_GOAL_ENDURANCE_RUN_ID: runId,
  PERSONA_GOAL_ENDURANCE_FIXTURE_TOKEN: token,
  UNRELATED_PARENT_SECRET: 'must-not-be-inherited',
};

function withProcessEnvironment<T>(
  env: Record<string, string | undefined>,
  run: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(env)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function fixtureConfig(
  overrides: Partial<MCPStdioConfig> = {},
): MCPStdioConfig {
  return {
    name: 'goal-endurance',
    transport: 'stdio',
    command: process.execPath,
    args: [
      path.resolve(
        'scripts',
        'persona-goal-acceptance',
        'public-fixture-mcp.mjs',
      ),
      fixtureUrl,
      agentRoot,
      runId,
    ],
    env: {},
    disabled: false,
    rootPath: process.cwd(),
    _buildCommand: '',
    _installCommand: '',
    source: { type: 'local' },
    ...overrides,
  };
}

const configuredTokenRejectionCases: Array<{
  description: string;
  overrides: Partial<MCPStdioConfig>;
  environment: Record<string, string | undefined>;
}> = [
  {
    description: 'an unrelated server',
    overrides: { name: 'unrelated-server' },
    environment: runnerEnv,
  },
  {
    description: 'an unsupported profile',
    overrides: {},
    environment: {
      ...runnerEnv,
      PERSONA_GOAL_ENDURANCE_PROFILE: 'terminal-only',
    },
  },
];

describe('goal endurance fixture runtime authorization', () => {
  let approved: ReturnType<typeof installTrustedHostProfile>;
  beforeEach(() => {
    approved = installTrustedHostProfile({ name: 'goal-endurance', nodeSource: '// Fixed owned fixture; these admission tests do not execute it.',
      args: [fixtureUrl, agentRoot, runId], environmentNames: [GOAL_ENDURANCE_FIXTURE_TOKEN_ENV] });
  });
  afterEach(() => approved.restore());
  function approvedConfig(overrides: Partial<MCPStdioConfig> = {}) {
    const config: MCPStdioConfig = { ...approved.config, rootPath: process.cwd(), source: { type: 'local' }, ...overrides };
    approved.approve(config);
    return config;
  }
  function approvedEnvironment(environment: Record<string, string | undefined> = runnerEnv) {
    const policy = trustedHostMcpPolicySchema.parse(approved.config.trustedHost);
    return { ...environment, PERSONA_GOAL_ENDURANCE_FIXTURE_ENTRY: policy.entryPoint,
      PERSONA_GOAL_ENDURANCE_FIXTURE_SOURCE_DIGEST: policy.sourceDigest };
  }
  it('attaches only the fixture token at the final stdio launch boundary', () => {
    const config = approvedConfig();
    const runtimeToken = resolveGoalEnduranceFixtureToken(config, approvedEnvironment());

    expect(runtimeToken).toBe(token);
    expect(config.env).toEqual(approved.config.env);
    expect(JSON.stringify(config)).not.toContain(token);

    const launch = withProcessEnvironment(approvedEnvironment(), () =>
      resolveStdioLaunch(config),
    );

    expect(launch.env[GOAL_ENDURANCE_FIXTURE_TOKEN_ENV]).toBe(token);
    expect(launch.env).not.toHaveProperty('UNRELATED_PARENT_SECRET');
    expect(config.env).toEqual(approved.config.env);
  });

  it.each(['terminal-only', 'public-services', ''])(
    'does not authorize unsupported profile %p',
    (profile) => {
      const unsupportedEnvironment = {
        ...runnerEnv,
        PERSONA_GOAL_ENDURANCE_PROFILE: profile,
      };
      const config = approvedConfig();
      expect(
        resolveGoalEnduranceFixtureToken(config, approvedEnvironment(unsupportedEnvironment)),
      ).toBeUndefined();

      const launch = withProcessEnvironment(approvedEnvironment(unsupportedEnvironment), () =>
        resolveStdioLaunch(config),
      );
      expect(launch.env).not.toHaveProperty(GOAL_ENDURANCE_FIXTURE_TOKEN_ENV);
    },
  );

  it.each(configuredTokenRejectionCases)(
    'refuses persisted spellings of the reserved token for $description',
    ({ overrides, environment }) => {
      const configuredToken = 'persisted-token-must-not-reach-child';
      const lowerCaseName = GOAL_ENDURANCE_FIXTURE_TOKEN_ENV.toLowerCase();
      const consented = approvedConfig({ ...overrides, env: approved.config.env });
      const config: MCPStdioConfig = { ...consented,
        env: { ...consented.env,
          [GOAL_ENDURANCE_FIXTURE_TOKEN_ENV]: configuredToken,
          [lowerCaseName]: configuredToken,
        },
      };

      expect(resolveGoalEnduranceFixtureToken(config, approvedEnvironment(environment))).toBeUndefined();
      const launch = () => withProcessEnvironment(approvedEnvironment(environment), () => resolveStdioLaunch(config));
      expect(launch).toThrow();
      try { launch(); } catch (error) { expect(String(error)).not.toContain(configuredToken); }
    },
  );

  it('fails closed for missing authorization or mismatched fixture identity', () => {
    const base = fixtureConfig();
    const wrongArgs = [...(base.args ?? [])];
    wrongArgs[1] = 'http://127.0.0.1:49999';

    expect(
      resolveGoalEnduranceFixtureToken(base, {
        ...runnerEnv,
        PERSONA_GOAL_ENDURANCE_FIXTURE_TOKEN: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolveGoalEnduranceFixtureToken(
        { ...base, name: 'unrelated-server' },
        runnerEnv,
      ),
    ).toBeUndefined();
    expect(
      resolveGoalEnduranceFixtureToken(
        { ...base, command: 'node' },
        runnerEnv,
      ),
    ).toBeUndefined();
    expect(
      resolveGoalEnduranceFixtureToken(
        { ...base, args: wrongArgs },
        runnerEnv,
      ),
    ).toBeUndefined();
    expect(
      resolveGoalEnduranceFixtureToken(
        { ...base, source: { type: 'remote' } },
        runnerEnv,
      ),
    ).toBeUndefined();
    expect(
      resolveGoalEnduranceFixtureToken(
        { ...base, disabled: true },
        runnerEnv,
      ),
    ).toBeUndefined();
  });
});
