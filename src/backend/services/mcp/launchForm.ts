import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';

/**
 * The launch form of a server config is what its program receives: secrets
 * decrypted, `${global:NAME}` bindings filled in and `{ value, metadata }`
 * entries flattened. Saved configs keep the stored form.
 *
 * Launch fingerprints and owner-approval digests are computed over the launch
 * form only. It is what runs and what the owner approves, it stays the same
 * when a secret is encrypted again, and it changes when a secret's value
 * changes. A stored form never matches a launch form once a server has a
 * secret (#1337), so every check passes the config it is given through here
 * first, whichever form it holds. The digests are keyed or slow hashes, so
 * they never contain a secret's value.
 */
export async function launchForm(config: MCPServerConfig): Promise<MCPServerConfig> {
  const { resolveConfigHeaders } = await import('./connection');
  return resolveConfigHeaders(config);
}

export async function stdioLaunchForm(config: MCPStdioConfig): Promise<MCPStdioConfig> {
  const launch = await launchForm(config);
  if (launch.transport !== 'stdio') throw new TypeError('A stdio server config resolved to another transport.');
  return launch;
}
