import path from 'node:path';
import { nativeCodexStartupArguments, nativeCodexThreadConfiguration } from '@/backend/services/model/adapters/codexNativeStartup';

const cwd = path.resolve('private-native-workspace');
const catalog = path.join(cwd, 'model-catalog.json');
const capability = 'fixture-private-bridge-capability';
const config = { model_catalog_json: catalog, forced_login_method: 'chatgpt',
  mcp_servers: { flujo: { url: `http://127.0.0.1:4201/${capability}`, http_headers: { Authorization: capability } } },
  developer_instructions: capability, service_tier: 'default', features: { code_mode_host: true } };

it('enforces restricted startup policy and catalog/trust without placing private bridge data on argv', () => {
  const args = nativeCodexStartupArguments({ cwd, config, authentication: 'chatgpt' });
  expect(args).toContain('features.code_mode_host=false');
  expect(args).toContain('features.multi_agent=false');
  expect(args).toContain(`model_catalog_json=${JSON.stringify(catalog)}`);
  expect(args).toContain(`projects.${JSON.stringify(cwd)}.trust_level="untrusted"`);
  expect(args).toContain('forced_login_method="chatgpt"');
  expect(args.some(value => value.includes(capability))).toBe(false);
  expect(args.some(value => value.startsWith('mcp_servers.'))).toBe(false);
  const thread = nativeCodexThreadConfiguration(config, 'chatgpt');
  expect(thread.mcp_servers).toBe(config.mcp_servers);
  expect(thread.features).toMatchObject({ code_mode_host: false, multi_agent: false });
});
it('preserves API-key Persona authentication in both launch and thread configuration', () => {
  const args = nativeCodexStartupArguments({ cwd, config, authentication: 'api-key' });
  expect(args.some(value => value.startsWith('forced_login_method='))).toBe(false);
  const thread = nativeCodexThreadConfiguration(config, 'api-key');
  expect(thread).not.toHaveProperty('forced_login_method');
  expect(thread.mcp_servers).toBe(config.mcp_servers);
});
it('allows the Persona computational bridge at startup and thread creation without enabling native capabilities', () => {
  const args = nativeCodexStartupArguments({ cwd, config, authentication: 'chatgpt', personaTools: true });
  expect(args).toContain('features.code_mode_host=true');
  const thread = nativeCodexThreadConfiguration(config, 'chatgpt', true);
  expect(thread.features).toMatchObject({ code_mode_host: true, code_mode: false,
    shell_tool: false, unified_exec: false, multi_agent: false, apps: false,
    browser_use: false, computer_use: false, plugins: false });
  expect(thread.mcp_servers).toBe(config.mcp_servers);
  expect(args.some(value => value.includes(capability))).toBe(false);
});
it('refuses an unverified relative catalog or caller-selected project trust override', () => {
  expect(() => nativeCodexStartupArguments({ cwd, config: { model_catalog_json: 'relative.json' }, authentication: 'chatgpt' })).toThrow('unavailable');
  expect(() => nativeCodexStartupArguments({ cwd, config, authentication: 'chatgpt', neutralTrustOverrides: ['features.shell_tool=true'] })).toThrow('unavailable');
});
it('admits only the credential-free local inventory responder and cannot project its supplied credentials', () => {
  const offline = { model_provider: 'inventory', model_providers: { inventory: { base_url: 'http://127.0.0.1:4202', env_key: capability } } };
  const args = nativeCodexStartupArguments({ cwd, config: offline, authentication: 'offline-inventory' });
  expect(args).toContain('model_providers.inventory.requires_openai_auth=false');
  expect(args.some(value => value.includes(capability))).toBe(false);
  expect(args.some(value => value.startsWith('forced_login_method='))).toBe(false);
  expect(JSON.stringify(nativeCodexThreadConfiguration(offline, 'offline-inventory')).includes(capability)).toBe(false);
  for (const base_url of ['https://api.openai.com', 'http://user:password@127.0.0.1:4202', 'http://127.0.0.1:4202/path']) {
    expect(() => nativeCodexStartupArguments({ cwd, config: { ...offline, model_providers: { inventory: { base_url } } }, authentication: 'offline-inventory' })).toThrow('unavailable');
  }
});
