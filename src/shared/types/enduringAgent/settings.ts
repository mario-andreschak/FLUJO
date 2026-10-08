import { z } from 'zod';

import {
  PERSONA_AUTONOMY_LEVELS,
  PERSONA_INTERRUPTION_POLICIES,
} from './enduringAgent';

const SafeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const PERSONA_EXPORT_EXCLUDED_CATEGORIES = [
  'persona_identity',
  'memories',
  'conversations',
  'activities',
  'mailbox',
  'leases',
  'work_items',
  'app_grants',
  'account_configurations',
  'credentials',
  'workspace_binding',
  'runtime_state',
] as const;

export const PersonaSettingsOptionsSchema = z.object({
  roles: z.array(z.object({
    roleVersionId: SafeIdSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(20_000).optional(),
  }).strict()),
  languages: z.array(z.object({
    code: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(160),
  }).strict()),
  lifecycleStates: z.array(z.enum(['idle', 'sleeping', 'disabled'])),
  autonomyLevels: z.array(z.enum(PERSONA_AUTONOMY_LEVELS)),
  interruptionPolicies: z.array(z.enum(PERSONA_INTERRUPTION_POLICIES)),
}).strict();

export type PersonaSettingsOptions = z.infer<typeof PersonaSettingsOptionsSchema>;

export const PersonaExportSelectionSchema = z.object({
  scope: z.literal('configuration_only').default('configuration_only'),
}).strict();

export type PersonaExportSelection = z.infer<typeof PersonaExportSelectionSchema>;

export const PersonaExportPreviewSchema = z.object({
  personaId: SafeIdSchema,
  generatedAt: z.number().int().nonnegative(),
  selection: PersonaExportSelectionSchema,
  included: z.object({
    roleTemplates: z.number().int().nonnegative(),
    roleVersions: z.number().int().nonnegative(),
    behaviorTemplates: z.number().int().nonnegative(),
    personaTemplates: z.number().int().nonnegative(),
  }).strict(),
  excluded: z.array(z.enum(PERSONA_EXPORT_EXCLUDED_CATEGORIES)),
  privacyWarnings: z.array(z.enum([
    'configuration_only',
    'shared_resources_referenced_not_copied',
  ])),
  artifact: z.object({
    filename: z.string().trim().min(1).max(255),
    contentType: z.literal('application/json'),
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type PersonaExportPreview = z.infer<typeof PersonaExportPreviewSchema>;
