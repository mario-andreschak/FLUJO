/**
 * Zod validation schema for the FLUJO package manifest format (issue #192).
 *
 * `flujoPackageSchema` is the single source of truth for validation: the same
 * schema runs in the authoring wizard, as the registry API's server-side
 * backstop, and at install time. It mirrors the TS types in `package.ts` and is
 * intentionally looser on the deeply-nested ReactFlow flow JSON (passthrough),
 * matching the older `../packages/manifest.ts` pattern.
 *
 * Hard security backstops enforced here:
 *  - model / MCP-server objects are `.strict()` — a stray `ApiKey`, `command`,
 *    `rootPath`, `serverUrl`, or OAuth field is REJECTED, not silently stripped;
 *  - no string anywhere may begin with the `encrypted:` prefix;
 *  - every `{{secret.NAME}}` placeholder and explicit secret ref must resolve to
 *    a declared `secrets[]` entry;
 *  - every package-internal flow reference (subflow / planned-execution
 *    `flowId`) must resolve to a packaged flow.
 */
import { z } from 'zod';
import {
  ENCRYPTED_PREFIX,
  IDENTIFIER_REGEX,
  PACKAGE_SCHEMA_VERSION,
  SEMVER_REGEX,
} from './constants';
import { collectSecretPlaceholdersDeep } from './secrets';

/** Deep-scan a value for any string beginning with the `encrypted:` prefix. */
export function hasEncryptedBlob(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith(ENCRYPTED_PREFIX);
  if (Array.isArray(value)) return value.some(hasEncryptedBlob);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasEncryptedBlob);
  }
  return false;
}

export const packageSecretSchema = z
  .object({
    name: z.string().min(1).regex(IDENTIFIER_REGEX, 'invalid secret name'),
    description: z.string().optional(),
    required: z.boolean(),
    default: z.string().optional(),
  })
  .strict();

export const packageApiKeyRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('secret'), secret: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('global'), var: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);

export const packagedModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    displayName: z.string().optional(),
    description: z.string().optional(),
    baseUrl: z.string().optional(),
    provider: z.string().optional(),
    adapter: z.string().optional(),
    promptTemplate: z.string().optional(),
    reasoningSchema: z.string().optional(),
    temperature: z.string().optional(),
    functionCallingSchema: z.string().optional(),
    contextWindow: z.number().optional(),
    maxTurns: z.number().optional(),
    maxTokens: z.number().optional(),
    folder: z.string().optional(),
    favorite: z.boolean().optional(),
    apiKeyRef: packageApiKeyRefSchema,
  })
  // strict: reject a leaked `ApiKey` (or any encrypted key material) outright.
  .strict();

export const mcpInstallOriginSchema = z
  .object({
    sourceType: z.enum(['github', 'registry', 'marketplace', 'remote']),
    ref: z.string().optional(),
    url: z.string().optional(),
    name: z.string().optional(),
  })
  .strict()
  .superRefine((origin, ctx) => {
    if (origin.sourceType === 'remote' && !origin.url) {
      ctx.addIssue({ code: 'custom', message: "installOrigin 'remote' requires a url" });
    }
    if (
      (origin.sourceType === 'github' || origin.sourceType === 'registry') &&
      !origin.ref
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `installOrigin '${origin.sourceType}' requires a ref`,
      });
    }
  });

export const envDeclarationSchema = z
  .object({
    name: z.string().min(1),
    isSecret: z.boolean(),
    secretRef: z.string().optional(),
    globalVar: z.string().optional(),
  })
  .strict();

export const packagedMcpServerSchema = z
  .object({
    name: z.string().min(1),
    transport: z.enum(['stdio', 'sse', 'streamable', 'websocket']),
    disabled: z.boolean().optional(),
    autoApprove: z.array(z.string()).optional(),
    folder: z.string().optional(),
    installOrigin: mcpInstallOriginSchema,
    envDeclarations: z.array(envDeclarationSchema),
    headerDeclarations: z.array(envDeclarationSchema).optional(),
  })
  // strict: reject raw `command`/`args`/`rootPath`/`serverUrl`/OAuth/server files.
  .strict();

export const packagedFlowSchema = z.object({
  flow: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      nodes: z.array(z.any()),
      edges: z.array(z.any()),
    })
    .catchall(z.unknown()),
  references: z
    .object({
      flowIds: z.array(z.string()).optional(),
      modelIds: z.array(z.string()).optional(),
      mcpServerNames: z.array(z.string()).optional(),
    })
    .optional(),
});

export const packagedPlannedExecutionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    /** Package-internal flow reference, remapped at install. */
    flowId: z.string().min(1),
    prompt: z.string(),
    trigger: z.any(),
  })
  .catchall(z.unknown());

export const flujoPackageSchema = z
  .object({
    schemaVersion: z.literal(PACKAGE_SCHEMA_VERSION),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.string().regex(SEMVER_REGEX, 'version must be valid semver'),
    author: z.string().optional(),
    publisher: z.string().optional(),
    tags: z.array(z.string()).optional(),
    requiredGlobals: z.array(z.string()).optional(),
    secrets: z.array(packageSecretSchema),
    models: z.array(packagedModelSchema),
    mcpServers: z.array(packagedMcpServerSchema),
    flows: z.array(packagedFlowSchema),
    plannedExecutions: z.array(packagedPlannedExecutionSchema),
  })
  .superRefine((pkg, ctx) => {
    // Backstop: no encrypted ciphertext may ride along anywhere.
    if (hasEncryptedBlob(pkg)) {
      ctx.addIssue({
        code: 'custom',
        message: `package contains an '${ENCRYPTED_PREFIX}' value; secret material must never be serialized`,
      });
    }

    // Every referenced secret name must be declared.
    const declared = new Set(pkg.secrets.map((s) => s.name));
    const referenced = new Set<string>(collectSecretPlaceholdersDeep(pkg));
    for (const model of pkg.models) {
      if (model.apiKeyRef.kind === 'secret') referenced.add(model.apiKeyRef.secret);
    }
    for (const server of pkg.mcpServers) {
      for (const decl of [...server.envDeclarations, ...(server.headerDeclarations ?? [])]) {
        if (decl.secretRef) referenced.add(decl.secretRef);
      }
    }
    for (const name of referenced) {
      if (!declared.has(name)) {
        ctx.addIssue({
          code: 'custom',
          message: `secret "${name}" is referenced but not declared in secrets[]`,
        });
      }
    }

    // Every package-internal flow reference must resolve to a packaged flow.
    const flowIds = new Set(pkg.flows.map((f) => f.flow.id));
    pkg.plannedExecutions.forEach((pe, i) => {
      if (!flowIds.has(pe.flowId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['plannedExecutions', i, 'flowId'],
          message: `plannedExecution "${pe.name}" references unknown flow id "${pe.flowId}"`,
        });
      }
    });
    pkg.flows.forEach((f, i) => {
      for (const ref of f.references?.flowIds ?? []) {
        if (!flowIds.has(ref)) {
          ctx.addIssue({
            code: 'custom',
            path: ['flows', i, 'references', 'flowIds'],
            message: `flow "${f.flow.name}" references unknown subflow id "${ref}"`,
          });
        }
      }
    });
  });
