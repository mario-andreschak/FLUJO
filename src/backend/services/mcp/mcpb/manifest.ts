/**
 * Reading an MCP bundle's `manifest.json` (#1230): check its shape, work out
 * the command it wants to run, and check the settings a person typed in.
 *
 * The rules follow the official format (MANIFEST.md and `src/shared/config.ts`
 * in github.com/modelcontextprotocol/mcpb, MIT): platform overrides replace
 * `command`/`args` and merge `env`; `${__dirname}`, `${HOME}`, `${DESKTOP}`,
 * `${DOCUMENTS}`, `${DOWNLOADS}`, `${pathSeparator}`, `${/}` and
 * `${user_config.KEY}` are replaced; an argument that is exactly one
 * `${user_config.KEY}` with several values becomes several arguments.
 * Unknown keys are ignored so bundles made for newer format versions still load.
 */
import os from 'os';
import path from 'path';
import { z } from 'zod';
import type {
  McpbErrorCode,
  McpbPlatform,
  McpbUserConfigField,
  McpbUserConfigValue,
} from '@/shared/types/mcp/mcpb';

export class McpbError extends Error {
  readonly code: McpbErrorCode;
  readonly status: number;
  readonly fields?: string[];
  constructor(message: string, code: McpbErrorCode, status = 400, fields?: string[]) {
    super(message);
    this.name = 'McpbError';
    this.code = code;
    this.status = status;
    if (fields) this.fields = fields;
  }
}

export const KNOWN_MANIFEST_VERSIONS: ReadonlySet<string> = new Set(['0.1', '0.2', '0.3', '0.4']);
export const MCPB_PLATFORMS: readonly McpbPlatform[] = ['darwin', 'win32', 'linux'];

const stringRecord = z.record(z.string(), z.string());
const mcpConfigSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  env: stringRecord.optional(),
  platform_overrides: z.record(z.string(), z.object({
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: stringRecord.optional(),
  })).optional(),
});
const userConfigValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const userConfigOptionSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
  title: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: userConfigValueSchema.optional(),
  multiple: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
const namedItemSchema = z.object({ name: z.string().trim().min(1), description: z.string().optional() });

const manifestSchema = z.object({
  manifest_version: z.string().optional(),
  dxt_version: z.string().optional(),
  name: z.string().trim().min(1),
  display_name: z.string().optional(),
  version: z.string().trim().min(1),
  description: z.string(),
  long_description: z.string().optional(),
  author: z.object({ name: z.string().trim().min(1), email: z.string().optional(), url: z.string().optional() }),
  repository: z.object({ type: z.string().optional(), url: z.string() }).optional(),
  homepage: z.string().optional(),
  documentation: z.string().optional(),
  support: z.string().optional(),
  license: z.string().optional(),
  server: z.object({
    type: z.enum(['node', 'python', 'binary', 'uv']),
    entry_point: z.string().trim().min(1),
    mcp_config: mcpConfigSchema.optional(),
  }),
  tools: z.array(namedItemSchema).optional(),
  tools_generated: z.boolean().optional(),
  prompts: z.array(namedItemSchema).optional(),
  prompts_generated: z.boolean().optional(),
  compatibility: z.object({
    platforms: z.array(z.string()).optional(),
    runtimes: z.object({ node: z.string().optional(), python: z.string().optional() }).optional(),
  }).optional(),
  user_config: z.record(z.string().regex(/^[^}\s]+$/, 'setting names cannot contain spaces or "}"'), userConfigOptionSchema).optional(),
  privacy_policies: z.array(z.string()).optional(),
}).refine((manifest) => manifest.manifest_version !== undefined || manifest.dxt_version !== undefined, {
  message: 'manifest_version is missing',
  path: ['manifest_version'],
}).refine((manifest) => manifest.server.type === 'uv' || manifest.server.mcp_config !== undefined, {
  message: 'is required for this server type',
  path: ['server', 'mcp_config'],
});

export type McpbManifest = z.infer<typeof manifestSchema>;

/** Parse and check `manifest.json`. Throws {@link McpbError} with plain words. */
export function parseMcpbManifest(text: string): McpbManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new McpbError('The bundle’s manifest.json is not valid JSON.', 'invalid-manifest');
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 5).map((issue) => {
      const where = issue.path.map(String).join('.') || 'manifest';
      return `${where}: ${issue.message}`;
    });
    throw new McpbError(`The bundle’s manifest.json is not complete: ${problems.join('; ')}.`, 'invalid-manifest');
  }
  return parsed.data;
}

export function manifestVersionOf(manifest: McpbManifest): string {
  return manifest.manifest_version ?? manifest.dxt_version ?? '';
}

export function manifestPlatforms(manifest: McpbManifest): McpbPlatform[] {
  const declared = manifest.compatibility?.platforms ?? [];
  return MCPB_PLATFORMS.filter((platform) => declared.includes(platform));
}

/** A bundle without a platform list works everywhere. */
export function platformSupported(manifest: McpbManifest, platform: string = process.platform): boolean {
  const declared = manifest.compatibility?.platforms;
  return !declared || declared.length === 0 || declared.includes(platform);
}

export function systemDirectories(home: string = os.homedir()): Record<string, string> {
  return {
    HOME: home,
    DESKTOP: path.join(home, 'Desktop'),
    DOCUMENTS: path.join(home, 'Documents'),
    DOWNLOADS: path.join(home, 'Downloads'),
  };
}

function replaceSystemDirectories(value: string, directories: Record<string, string>): string {
  return value.replace(/\$\{(HOME|DESKTOP|DOCUMENTS|DOWNLOADS)\}/g, (_match, name: string) => directories[name] ?? '');
}

function defaultValue(value: McpbUserConfigValue | undefined, directories: Record<string, string>): McpbUserConfigValue | undefined {
  if (typeof value === 'string') return replaceSystemDirectories(value, directories);
  if (Array.isArray(value)) return value.map((item) => replaceSystemDirectories(item, directories));
  return value;
}

/** The settings form, in manifest order. */
export function userConfigFields(manifest: McpbManifest, directories = systemDirectories()): McpbUserConfigField[] {
  return Object.entries(manifest.user_config ?? {}).map(([key, option]) => {
    const fallback = defaultValue(option.default, directories);
    return {
      key,
      type: option.type,
      title: option.title?.trim() || key,
      description: option.description?.trim() ?? '',
      required: option.required === true,
      sensitive: option.sensitive === true && option.type === 'string',
      multiple: option.multiple === true && (option.type === 'directory' || option.type === 'file'),
      ...(fallback !== undefined ? { default: fallback } : {}),
      ...(option.min !== undefined ? { min: option.min } : {}),
      ...(option.max !== undefined ? { max: option.max } : {}),
    };
  });
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && (value.length === 0 || value.some((item) => item === '' || item === undefined || item === null)));
}

function coerceValue(field: McpbUserConfigField, value: unknown): McpbUserConfigValue | undefined {
  switch (field.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      return undefined;
    case 'number': {
      const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
      if (!Number.isFinite(number)) return undefined;
      if (field.min !== undefined && number < field.min) return undefined;
      if (field.max !== undefined && number > field.max) return undefined;
      return number;
    }
    default: {
      if (field.multiple) {
        const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : undefined;
        if (!items || items.some((item) => typeof item !== 'string')) return undefined;
        const cleaned = (items as string[]).map((item) => item.trim()).filter(Boolean);
        return cleaned;
      }
      if (typeof value !== 'string' || /[\0]/.test(value)) return undefined;
      return field.sensitive ? value : value.trim();
    }
  }
}

export interface CheckedUserConfig {
  values: Record<string, McpbUserConfigValue>;
  /** Sensitive keys left empty whose saved secret is kept. */
  keptSecrets: string[];
}

/**
 * Check the values a person typed. Empty fields take the manifest default.
 * A sensitive field left empty keeps the saved secret when `savedSecrets` has it.
 */
export function checkUserConfig(
  fields: McpbUserConfigField[],
  input: Record<string, unknown>,
  savedSecrets: ReadonlySet<string> = new Set(),
): CheckedUserConfig {
  const values: Record<string, McpbUserConfigValue> = {};
  const keptSecrets: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const field of fields) {
    const raw = Object.prototype.hasOwnProperty.call(input, field.key) ? input[field.key] : undefined;
    const value = isEmptyValue(raw) ? undefined : coerceValue(field, raw);
    if (isEmptyValue(raw) || (Array.isArray(value) && value.length === 0)) {
      if (field.sensitive && savedSecrets.has(field.key)) {
        keptSecrets.push(field.key);
        continue;
      }
      if (field.default !== undefined && !isEmptyValue(field.default)) {
        values[field.key] = field.default;
        continue;
      }
      if (field.required) missing.push(field.key);
      continue;
    }
    if (value === undefined) invalid.push(field.key);
    else values[field.key] = value;
  }
  if (missing.length > 0) {
    const titles = fields.filter((field) => missing.includes(field.key)).map((field) => `"${field.title}"`);
    throw new McpbError(`Fill in ${titles.join(', ')} before installing.`, 'missing-config', 400, missing);
  }
  if (invalid.length > 0) {
    const titles = fields.filter((field) => invalid.includes(field.key)).map((field) => `"${field.title}"`);
    throw new McpbError(`Check ${titles.join(', ')}: the value does not fit what the bundle expects.`, 'invalid-config', 400, invalid);
  }
  return { values, keptSecrets };
}

export interface McpbLaunchPlan {
  command: string;
  args: string[];
  env: Record<string, { value: string; secret: boolean }>;
  /** Sensitive settings that end up in the command line instead of the environment. */
  secretInCommandLine: boolean;
  /** user_config key → env name, for env entries that are exactly `${user_config.KEY}`. */
  secretEnv: Record<string, string>;
}

/** The raw command template for this platform, before any value is filled in. */
export function launchTemplate(manifest: McpbManifest, platform: string = process.platform): { command: string; args: string[]; env: Record<string, string> } {
  const config = manifest.server.mcp_config;
  if (!config) {
    return { command: 'uv', args: ['run', '--directory', '${__dirname}', manifest.server.entry_point], env: {} };
  }
  const override = config.platform_overrides?.[platform];
  return {
    command: override?.command || config.command,
    args: [...(override?.args || config.args || [])],
    env: { ...(config.env ?? {}), ...(override?.env ?? {}) },
  };
}

const USER_CONFIG_TOKEN = /^\$\{user_config\.([^}]+)\}$/;
const VARIABLE = /\$\{([^}]+)\}/g;

function valueText(value: McpbUserConfigValue | undefined): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
}

/**
 * Fill in the launch template. `values` holds every known setting; a kept
 * secret is passed as `keptSecrets` and must only appear as a whole env value.
 */
export function buildLaunchPlan(
  manifest: McpbManifest,
  options: {
    dirname: string;
    values: Record<string, McpbUserConfigValue>;
    sensitiveKeys: ReadonlySet<string>;
    keptSecrets?: ReadonlySet<string>;
    platform?: string;
    directories?: Record<string, string>;
    pathSeparator?: string;
  },
): McpbLaunchPlan {
  const template = launchTemplate(manifest, options.platform);
  const separator = options.pathSeparator ?? path.sep;
  const directories = options.directories ?? systemDirectories();
  const keptSecrets = options.keptSecrets ?? new Set<string>();
  const usedSecrets = new Set<string>();

  const replace = (text: string): string => text.replace(VARIABLE, (match, name: string) => {
    if (name === '__dirname') return options.dirname;
    if (name === 'pathSeparator' || name === '/') return separator;
    if (name in directories) return directories[name];
    if (name.startsWith('user_config.')) {
      const key = name.slice('user_config.'.length);
      if (keptSecrets.has(key)) {
        throw new McpbError('This version uses a saved secret in a new way. Type it in again.', 'missing-config', 400, [key]);
      }
      if (options.sensitiveKeys.has(key)) usedSecrets.add(key);
      return valueText(options.values[key]);
    }
    return match;
  });

  const args = template.args.flatMap((arg) => {
    const token = arg.match(USER_CONFIG_TOKEN);
    const value = token ? options.values[token[1]] : undefined;
    if (token && Array.isArray(value) && !keptSecrets.has(token[1])) return value.map(String);
    return [replace(arg)];
  });
  const command = replace(template.command);
  const secretInCommandLine = usedSecrets.size > 0;

  const env: McpbLaunchPlan['env'] = {};
  const secretEnv: Record<string, string> = {};
  for (const [name, raw] of Object.entries(template.env)) {
    const token = raw.match(USER_CONFIG_TOKEN);
    if (token && keptSecrets.has(token[1])) {
      secretEnv[token[1]] = name;
      env[name] = { value: '', secret: true };
      continue;
    }
    usedSecrets.clear();
    const value = replace(raw);
    const secret = usedSecrets.size > 0;
    if (token && secret) secretEnv[token[1]] = name;
    env[name] = { value, secret };
  }
  return { command, args, env, secretInCommandLine, secretEnv };
}
