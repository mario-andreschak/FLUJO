import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withNpmDevDependencies } from '@/utils/mcp/npmEnvironment';

const launcherUrl = pathToFileURL(path.join(process.cwd(), 'scripts', 'launch-next.mjs')).href;

function evaluateLaunchEnv(env: Record<string, string>): Record<string, string> {
  const program = `
    import { buildLaunchEnv } from ${JSON.stringify(launcherUrl)};
    const env = buildLaunchEnv(JSON.parse(process.argv[1]));
    process.stdout.write(JSON.stringify(env));
  `;
  return JSON.parse(execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', program, JSON.stringify(env)],
    { cwd: process.cwd(), encoding: 'utf8' },
  ));
}

describe('npm environment for source-built MCP servers', () => {
  it('forces include=dev after caller overrides and removes conflicting case variants', () => {
    const result = withNpmDevDependencies(
      { NODE_ENV: 'production', NPM_CONFIG_INCLUDE: 'optional' },
      { npm_config_include: 'prod', npm_config_omit: 'dev' },
    );

    expect(result.NODE_ENV).toBe('production');
    expect(result.npm_config_omit).toBe('dev');
    expect(result.npm_config_include).toBe('dev');
    expect(Object.keys(result).filter((key) => key.toLowerCase() === 'npm_config_include'))
      .toEqual(['npm_config_include']);
  });

  it('applies the same setting to both dev and production Next launchers', () => {
    for (const NODE_ENV of ['development', 'production']) {
      const source = {
        NODE_ENV,
        NPM_CONFIG_INCLUDE: 'optional',
        npm_config_omit: 'dev',
        // Suppress the informational fallback on Node versions without --use-system-ca.
        NODE_EXTRA_CA_CERTS: 'test-ca.pem',
      };
      const result = evaluateLaunchEnv(source);

      expect(result.NODE_ENV).toBe(NODE_ENV);
      expect(result.npm_config_include).toBe('dev');
      expect(Object.keys(result).filter((key) => key.toLowerCase() === 'npm_config_include'))
        .toEqual(['npm_config_include']);
      expect(source).toHaveProperty('NPM_CONFIG_INCLUDE', 'optional');
    }
  });
});
