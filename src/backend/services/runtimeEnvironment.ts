import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { getAppDir, getInstallMode } from '@/utils/paths';
import {
  RUNTIME_ENVIRONMENT_DEFINITIONS,
  RUNTIME_ENVIRONMENT_NAMES,
} from '@/shared/runtimeEnvironment';

const MANAGED_START = '# --- FLUJO managed runtime environment ---';
const MANAGED_END = '# --- end FLUJO managed runtime environment ---';
const MAX_VALUE_LENGTH = 16 * 1024;
const MAX_FILE_LENGTH = 256 * 1024;

export function runtimeEnvironmentFile(): string {
  const launcherRoot = process.env.FLUJO_RUNTIME_ENV_DIR?.trim();
  if (launcherRoot) return path.join(path.resolve(launcherRoot), '.env.local');
  const mode = getInstallMode();
  // Keep the bootstrap file stable even when it changes FLUJO_DATA_DIR itself.
  // npm packages are read-only and Docker has a dedicated writable volume.
  const root = mode === 'npm'
    ? path.join(os.homedir(), '.flujo')
    : mode === 'container'
      ? '/app/data'
      : getAppDir();
  return path.join(root, '.env.local');
}

function dotenvValue(value: string): string {
  return JSON.stringify(value).replaceAll('\\u2028', '\\u2028').replaceAll('\\u2029', '\\u2029');
}

function parseManagedBlock(contents: string): Record<string, string> {
  const start = contents.indexOf(MANAGED_START);
  const end = contents.indexOf(MANAGED_END, start + MANAGED_START.length);
  if (start < 0 || end < 0) return {};
  const block = contents.slice(start + MANAGED_START.length, end);
  const values: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || !RUNTIME_ENVIRONMENT_NAMES.has(match[1])) continue;
    const raw = match[2].trim();
    try {
      values[match[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw;
    } catch {
      values[match[1]] = raw;
    }
  }
  return values;
}

export async function readRuntimeEnvironmentFile(): Promise<{
  path: string;
  configured: Record<string, string>;
}> {
  const file = runtimeEnvironmentFile();
  try {
    return { path: file, configured: parseManagedBlock(await fs.readFile(file, 'utf8')) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, configured: {} };
    throw error;
  }
}

export async function writeRuntimeEnvironmentFile(values: Record<string, unknown>): Promise<void> {
  const normalized: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(values)) {
    if (!RUNTIME_ENVIRONMENT_NAMES.has(name)) throw new Error(`Unsupported environment variable: ${name}`);
    if (typeof rawValue !== 'string') throw new Error(`${name} must be a string`);
    if (rawValue.length > MAX_VALUE_LENGTH) throw new Error(`${name} exceeds ${MAX_VALUE_LENGTH} characters`);
    if (rawValue.length > 0) normalized[name] = rawValue;
  }

  const file = runtimeEnvironmentFile();
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const managedPattern = new RegExp(
    `${MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`,
    'g',
  );
  const unmanaged = existing.replace(managedPattern, '').trimEnd();
  const lines = RUNTIME_ENVIRONMENT_DEFINITIONS
    .map(({ name }) => name)
    .filter((name) => normalized[name] !== undefined)
    .map((name) => `${name}=${dotenvValue(normalized[name])}`);
  const managed = lines.length ? `${MANAGED_START}\n${lines.join('\n')}\n${MANAGED_END}\n` : '';
  const next = `${unmanaged}${unmanaged && managed ? '\n\n' : ''}${managed}`;
  if (next.length > MAX_FILE_LENGTH) throw new Error('The resulting .env.local file is too large');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, next, { encoding: 'utf8', mode: 0o600 });
}
