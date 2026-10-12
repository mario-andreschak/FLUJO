import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveStdioLaunch } from '@/backend/services/mcp/connection';
import { ensureWorkspaceDirs, getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { getDataDir } from '@/utils/paths';
import { installTrustedHostProfile } from './fixtures/trustedHostProfile';
import { trustedHostMcpPolicySchema } from '@/backend/services/security/trustedHostMcp';

describe('approved host runtime-home isolation', () => {
  let approved: ReturnType<typeof installTrustedHostProfile>;
  beforeEach(async () => {
    approved = installTrustedHostProfile({ environment: { HOME: 'synthetic-original-home' }, runtimeHome: 'isolated' });
    await ensureWorkspaceDirs();
  });
  afterEach(() => approved.restore());
  const runtimeDirectory = () => path.join(getWorkspaceDataDir(), 'userdata', 'mcp-runtime',
    createHash('sha256').update(approved.config.name).digest('hex').slice(0, 24));

  it('honors the explicit runtime-home option for a genuinely approved host', () => {
    const host = { ...approved.config, trustedHost: { ...approved.config.trustedHost!, runtimeHome: 'host' as const } };
    approved.approve(host);
    expect(resolveStdioLaunch(host, { isolateRuntimeHome: false }).env.HOME).toBe('synthetic-original-home');
    approved.approve();
    const isolated = resolveStdioLaunch(approved.config, { isolateRuntimeHome: true });
    expect(isolated.env.HOME).toBe(path.join(runtimeDirectory(), 'home'));
    expect(isolated.env.USERPROFILE).toBe(isolated.env.HOME);
    expect(isolated.env.XDG_CONFIG_HOME).toBe(path.join(isolated.env.HOME, '.config'));
  });

  it('refuses isolation under a host-only grant and under an isolated grant missing injected environment names', () => {
    const host = { ...approved.config, trustedHost: { ...approved.config.trustedHost!, runtimeHome: 'host' as const } };
    approved.approve(host);
    expect(() => resolveStdioLaunch(host, { isolateRuntimeHome: true }))
      .toThrow(expect.objectContaining({ code: 'HOST_POLICY_INVALID' }));
    const incomplete = { ...approved.config, trustedHost: { ...approved.config.trustedHost!, environmentNames: Object.keys(approved.config.env) } };
    approved.approve(incomplete);
    expect(() => resolveStdioLaunch(incomplete, { isolateRuntimeHome: true }))
      .toThrow(expect.objectContaining({ code: 'HOST_POLICY_INVALID' }));
  });

  it('refuses an occupied runtime anchor without replacing its bytes or falling back to the host home', () => {
    fs.mkdirSync(path.dirname(runtimeDirectory()), { recursive: true });
    fs.writeFileSync(runtimeDirectory(), 'occupied-runtime-anchor');
    expect(() => resolveStdioLaunch(approved.config, { isolateRuntimeHome: true }))
      .toThrow(expect.objectContaining({ code: 'UNSAFE_MCP_RUNTIME_DIRECTORY' }));
    expect(fs.readFileSync(runtimeDirectory(), 'utf8')).toBe('occupied-runtime-anchor');
  });

  it('replaces reviewed stale FLUJO roots with the selected workspace roots for isolated launches', () => {
    const stale = { ...approved.config, env: { ...approved.config.env,
      FLUJO_PARENT_DATA_DIR: 'stale-parent', FLUJO_DATA_DIR: 'stale-workspace', FLUJO_WORKSPACE: 'stale-workspace-name' } };
    approved.approve(stale);
    const launch = resolveStdioLaunch(stale, { isolateRuntimeHome: true });
    expect(launch.env.FLUJO_PARENT_DATA_DIR).toBe(getDataDir());
    expect(launch.env.FLUJO_DATA_DIR).toBe(getWorkspaceDataDir());
    expect(launch.env.FLUJO_WORKSPACE).toBe(getCurrentWorkspace());
  });

  it.each(['FLUJO_PARENT_DATA_DIR', 'FLUJO_DATA_DIR', 'FLUJO_WORKSPACE'])(
    'requires explicit reviewed authority for injected %s', name => {
      const policy = trustedHostMcpPolicySchema.parse(approved.config.trustedHost);
      const incomplete = { ...approved.config, trustedHost: { ...policy,
        environmentNames: policy.environmentNames.filter(value => value !== name) } };
      approved.approve(incomplete);
      expect(() => resolveStdioLaunch(incomplete, { isolateRuntimeHome: true }))
        .toThrow(expect.objectContaining({ code: 'HOST_POLICY_INVALID' }));
    },
  );
});
