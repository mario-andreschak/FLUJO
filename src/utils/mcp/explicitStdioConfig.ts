import type { MCPStdioConfig } from '@/shared/types/mcp';
import { mcpValueRecord } from './values';

/** Read complete JSON objects; regex extraction truncates nested env objects. */
export function explicitStdioConfig(text: string, preferredName?: string): Partial<MCPStdioConfig> | undefined {
  const candidates = [text.trim(), ...Array.from(
    text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g), match => match[1],
  )];
  for (const candidate of candidates) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const root = parsed as Record<string, unknown>;
    const servers = root.mcpServers;
    const entries = servers && typeof servers === 'object' && !Array.isArray(servers)
      ? Object.entries(servers as Record<string, unknown>)
      : typeof root.command === 'string' ? [[preferredName ?? 'mcp-server', root] as const] : Object.entries(root);
    const ordered = [...entries].sort(([a], [b]) => Number(b === preferredName) - Number(a === preferredName));
    for (const [name, value] of ordered) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const config = value as Record<string, unknown>;
      if (typeof config.command !== 'string' || !config.command.trim()) continue;
      if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string'))) continue;
      return {
        name, transport: 'stdio', command: config.command,
        args: (config.args ?? []) as string[], env: mcpValueRecord(config.env),
        disabled: config.disabled === true,
      };
    }
  }
  return undefined;
}

/** Published package runners manage their own dependencies, outside the clone. */
export function isPublishedPackageRunner(command: string, args: string[] = []): boolean {
  const executable = command.split(/[\\/]/).pop()?.replace(/\.(exe|cmd)$/i, '').toLowerCase();
  const runner = executable === 'uvx' || executable === 'npx' || executable === 'pipx'
    || (executable === 'uv' && args[0] === 'tool' && args[1] === 'run');
  return runner && !args.some(arg => /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/]|file:)/i.test(arg));
}
