/**
 * Build an environment for commands that may install/build an npm-based MCP
 * server. npm derives `omit=dev` from NODE_ENV=production, which is the normal
 * environment under `next start`. The `include=dev` config wins over that omit
 * and keeps build tools such as TypeScript available.
 *
 * Remove case variants first because Windows treats environment keys as
 * case-insensitive when it constructs a child process environment block.
 */
export function withNpmDevDependencies(
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...overrides };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_include') delete env[key];
  }
  env.npm_config_include = 'dev';
  return env;
}
