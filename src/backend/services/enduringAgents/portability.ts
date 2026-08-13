import { createHash } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson, snapshotBehaviorFlow } from './behaviorRevisions';
import type {
  Persona,
  RoleCapabilityRequirements,
  RoleDefinition,
  RoleVersion,
} from '@/shared/types/enduringAgent';
import {
  PersonaSchema,
  RoleDefinitionSchema,
  RoleVersionSchema,
} from '@/shared/types/enduringAgent';
import type {
  FlujoPackage,
  PackagedBehaviorTemplate,
  PackagedPersonaTemplate,
  PackagedRoleTemplate,
} from '@/shared/types/package';
import {
  collectFlowReferences,
  packagedBehaviorTemplateSchema,
  packagedPersonaTemplateSchema,
  packagedRoleTemplateSchema,
} from '@/shared/types/package';

const DRAFT_CONSTRAINTS = [
  'Do not invent or persist biography or memory.',
  'Do not create, authorize, or bind accounts or credentials.',
  'Return configuration only; exclude activities, conversations, grants, mailbox, leases, and workspace-private state.',
  'Keep Flow boundServer, enabledTools, roots, and permission rules authoritative.',
] as const;

export const RolePersonaDraftProposalSchema = z.object({
  personaTemplate: packagedPersonaTemplateSchema,
  roleTemplate: packagedRoleTemplateSchema.optional(),
  behaviorTemplates: z.array(packagedBehaviorTemplateSchema).max(64).optional(),
  suggestedMcpServers: z.array(z.string().trim().min(1).max(160)).max(128).optional(),
}).strict().superRefine((proposal, ctx) => {
  if (
    proposal.roleTemplate
    && !proposal.roleTemplate.versions.some(
      (version) => version.id === proposal.personaTemplate.roleVersionId,
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['personaTemplate', 'roleVersionId'],
      message: 'Persona draft must select a version from the proposed Role template',
    });
  }
});

export type RolePersonaDraftProposal = z.infer<typeof RolePersonaDraftProposalSchema>;
export type RolePersonaDraftStatus = 'pending_review' | 'approved' | 'rejected';

export interface RolePersonaDraft {
  id: string;
  request: string;
  proposal: RolePersonaDraftProposal;
  /** Review token over the exact generated proposal. */
  contentDigest: string;
  status: RolePersonaDraftStatus;
  createdAt: number;
  reviewedAt?: number;
  reviewedBy?: string;
  reviewNotes?: string;
}

export interface RolePersonaDraftGenerator {
  (input: {
    request: string;
    constraints: readonly string[];
  }): Promise<unknown>;
}

/**
 * Provider-neutral AI entry point. Generated data is schema-checked but remains
 * inert until an explicit review approves it.
 */
export async function generateRolePersonaDraft(input: {
  id: string;
  request: string;
  generate: RolePersonaDraftGenerator;
  now?: number;
}): Promise<RolePersonaDraft> {
  const proposal = await input.generate({
    request: input.request,
    constraints: DRAFT_CONSTRAINTS,
  });
  return createRolePersonaDraft({
    id: input.id,
    request: input.request,
    proposal,
    now: input.now,
  });
}

function hardenDraftProposal(value: unknown): RolePersonaDraftProposal {
  const proposal = RolePersonaDraftProposalSchema.parse(value);
  for (const version of proposal.roleTemplate?.versions ?? []) {
    for (const slot of version.behaviorSlots) {
      slot.flowTemplate = snapshotBehaviorFlow(slot.flowTemplate);
    }
  }
  for (const template of proposal.behaviorTemplates ?? []) {
    template.flowTemplate = snapshotBehaviorFlow(template.flowTemplate);
  }
  return RolePersonaDraftProposalSchema.parse(proposal);
}

function rolePersonaDraftDigest(proposal: RolePersonaDraftProposal): string {
  return createHash('sha256').update(canonicalJson(proposal)).digest('hex');
}

export function createRolePersonaDraft(input: {
  id: string;
  request: string;
  proposal: unknown;
  now?: number;
}): RolePersonaDraft {
  const id = input.id.trim();
  const request = input.request.trim();
  if (!id) throw new Error('Draft id is required.');
  if (!request) throw new Error('Draft request is required.');
  const proposal = hardenDraftProposal(input.proposal);
  return {
    id,
    request,
    proposal,
    contentDigest: rolePersonaDraftDigest(proposal),
    status: 'pending_review',
    createdAt: input.now ?? Date.now(),
  };
}

export function reviewRolePersonaDraft(
  draft: RolePersonaDraft,
  review: {
    decision: 'approve' | 'reject';
    reviewedBy: string;
    expectedDigest: string;
    notes?: string;
    now?: number;
  },
): RolePersonaDraft {
  if (draft.status !== 'pending_review') {
    throw new Error('Only a pending Role/Persona draft may be reviewed.');
  }
  const currentDigest = rolePersonaDraftDigest(draft.proposal);
  if (review.expectedDigest !== draft.contentDigest || currentDigest !== draft.contentDigest) {
    throw new Error('Role/Persona draft changed after generation; review the new digest.');
  }
  const reviewedBy = review.reviewedBy.trim();
  if (!reviewedBy) throw new Error('Reviewer identity is required.');
  return {
    ...draft,
    proposal: structuredClone(draft.proposal),
    status: review.decision === 'approve' ? 'approved' : 'rejected',
    reviewedAt: review.now ?? Date.now(),
    reviewedBy,
    reviewNotes: review.notes?.trim() || undefined,
  };
}

/**
 * Returns configuration fragments only. Persistence remains the caller's
 * explicit action, and rejected/unreviewed drafts cannot materialize.
 */
export function materializeReviewedRoleDraft(draft: RolePersonaDraft): {
  roleTemplate?: PackagedRoleTemplate;
  behaviorTemplates: PackagedBehaviorTemplate[];
  personaTemplate: PackagedPersonaTemplate;
  suggestedMcpServers: string[];
} {
  if (draft.status !== 'approved') {
    throw new Error('Role/Persona draft requires explicit approval before materialization.');
  }
  if (rolePersonaDraftDigest(draft.proposal) !== draft.contentDigest) {
    throw new Error('Approved Role/Persona draft content no longer matches its review digest.');
  }
  return {
    roleTemplate: draft.proposal.roleTemplate
      ? structuredClone(draft.proposal.roleTemplate)
      : undefined,
    behaviorTemplates: structuredClone(draft.proposal.behaviorTemplates ?? []),
    personaTemplate: structuredClone(draft.proposal.personaTemplate),
    suggestedMcpServers: [...(draft.proposal.suggestedMcpServers ?? [])],
  };
}

/**
 * Build the portable part of a Role/Persona export. The allow-list is
 * intentional: even when a caller passes a richer live Persona record, only
 * reusable configuration crosses the boundary.
 */
export function buildAgentConfigurationExport(input: {
  roleDefinition: RoleDefinition;
  roleVersions: RoleVersion[];
  persona?: Persona & Record<string, unknown>;
  behaviorTemplates?: PackagedBehaviorTemplate[];
}): {
  roleTemplates: PackagedRoleTemplate[];
  behaviorTemplates: PackagedBehaviorTemplate[];
  personaTemplates: PackagedPersonaTemplate[];
} {
  const definition = RoleDefinitionSchema.parse(input.roleDefinition);
  const versions = input.roleVersions.map((version) => RoleVersionSchema.parse(version));
  if (versions.length === 0) throw new Error('At least one Role version is required.');
  if (versions.some((version) => version.roleDefinitionId !== definition.id)) {
    throw new Error('Every exported Role version must belong to the exported Role definition.');
  }

  const personaTemplates: PackagedPersonaTemplate[] = [];
  if (input.persona) {
    const persona = PersonaSchema.parse({
      schemaVersion: input.persona.schemaVersion,
      id: input.persona.id,
      name: input.persona.name,
      roleVersionId: input.persona.roleVersionId,
      lifecycleState: input.persona.lifecycleState,
      mission: input.persona.mission,
      presentation: input.persona.presentation,
      autonomyLevel: input.persona.autonomyLevel,
      interruptionPolicy: input.persona.interruptionPolicy,
      coreMemoryItemIds: input.persona.coreMemoryItemIds,
      factoryKeyHash: input.persona.factoryKeyHash,
      provisioningState: input.persona.provisioningState,
      createdAt: input.persona.createdAt,
      updatedAt: input.persona.updatedAt,
    });
    if (!versions.some((version) => version.id === persona.roleVersionId)) {
      throw new Error('Exported Persona must be pinned to an exported Role version.');
    }
    personaTemplates.push(packagedPersonaTemplateSchema.parse({
      name: persona.name,
      roleVersionId: persona.roleVersionId,
      mission: persona.mission,
      presentation: persona.presentation,
      autonomyLevel: persona.autonomyLevel,
      interruptionPolicy: persona.interruptionPolicy,
    }));
  }

  return {
    roleTemplates: [{
      definition: structuredClone(definition),
      versions: structuredClone(versions),
    }],
    behaviorTemplates: (input.behaviorTemplates ?? []).map(
      (template) => packagedBehaviorTemplateSchema.parse(structuredClone(template)),
    ),
    personaTemplates,
  };
}

export interface InstalledCapabilityProvider {
  name: string;
  capabilities: readonly string[];
}

export interface CapabilityResolution {
  satisfied: string[];
  missing: string[];
  ambiguous: Array<{ capability: string; providers: string[] }>;
  invalidSelections: Array<{ capability: string; provider: string }>;
  choices: Record<string, string[]>;
  recommendations: Record<string, string>;
  selectedBindings: Record<string, string>;
  ready: boolean;
}

/**
 * Resolves semantic requirements for review/install UX only. It never edits a
 * Flow or grants a runtime tool; boundServer and enabledTools stay Flow-owned.
 */
export function resolveRoleCapabilities(input: {
  requirements?: RoleCapabilityRequirements;
  providers: readonly InstalledCapabilityProvider[];
  selectedBindings?: Readonly<Record<string, string>>;
}): CapabilityResolution {
  const required = [...new Set(input.requirements?.semantic ?? [])].sort();
  const preferred = new Set(input.requirements?.preferredMcpServers ?? []);
  const selected = input.selectedBindings ?? {};
  const choices: Record<string, string[]> = {};
  const recommendations: Record<string, string> = {};
  const selectedBindings: Record<string, string> = {};
  const satisfied: string[] = [];
  const missing: string[] = [];
  const ambiguous: CapabilityResolution['ambiguous'] = [];
  const invalidSelections: CapabilityResolution['invalidSelections'] = [];

  for (const capability of required) {
    const providers = input.providers
      .filter((provider) => provider.capabilities.includes(capability))
      .map((provider) => provider.name)
      .sort();
    choices[capability] = providers;
    if (providers.length === 0) {
      missing.push(capability);
      continue;
    }

    const selectedProvider = selected[capability];
    if (selectedProvider !== undefined) {
      if (!providers.includes(selectedProvider)) {
        invalidSelections.push({ capability, provider: selectedProvider });
        continue;
      }
      selectedBindings[capability] = selectedProvider;
      satisfied.push(capability);
      continue;
    }

    const preferredProvider = providers.find((provider) => preferred.has(provider));
    if (preferredProvider) recommendations[capability] = preferredProvider;

    if (providers.length === 1) {
      selectedBindings[capability] = providers[0];
      satisfied.push(capability);
    } else {
      ambiguous.push({ capability, providers });
    }
  }

  return {
    satisfied,
    missing,
    ambiguous,
    invalidSelections,
    choices,
    recommendations,
    selectedBindings,
    ready: missing.length === 0
      && ambiguous.length === 0
      && invalidSelections.length === 0,
  };
}

export type RolePackageCollisionKind =
  | 'role_definition'
  | 'role_version_id'
  | 'role_version_number'
  | 'behavior_slot'
  | 'behavior_template';

export interface RolePackageCollision {
  kind: RolePackageCollisionKind;
  importedId: string;
  existingId: string;
  detail: string;
  requiresDecision: true;
}

export interface PersonaRoleUpgrade {
  personaId: string;
  roleDefinitionId: string;
  fromRoleVersionId: string;
  toRoleVersionId: string;
  requiresExplicitRepin: true;
}

export interface RolePackageImportPlan {
  collisions: RolePackageCollision[];
  capabilityResolutions: Array<{
    targetType: 'role_version' | 'behavior_template';
    targetId: string;
    resolution: CapabilityResolution;
  }>;
  flowBindingRequirements: Array<{
    templateId: string;
    requiredServerNames: string[];
    missingServerNames: string[];
  }>;
  upgrades: PersonaRoleUpgrade[];
  requiresReview: boolean;
  readyToImport: boolean;
  personasRemainPinned: true;
}

/**
 * Dry-run planner for collision, capability-binding and version-upgrade UX.
 * It deliberately returns no mutation callback and never repins a Persona.
 */
export function planRolePackageImport(input: {
  package: FlujoPackage;
  existingRoleDefinitions: readonly RoleDefinition[];
  existingRoleVersions: readonly RoleVersion[];
  existingPersonas: readonly Pick<Persona, 'id' | 'roleVersionId'>[];
  existingBehaviorTemplateIds?: readonly string[];
  providers: readonly InstalledCapabilityProvider[];
  selectedBindings?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}): RolePackageImportPlan {
  const collisions: RolePackageCollision[] = [];
  const existingDefinitionsById = new Map(
    input.existingRoleDefinitions.map((definition) => [definition.id, definition]),
  );
  const existingVersionsById = new Map(
    input.existingRoleVersions.map((version) => [version.id, version]),
  );
  const existingVersionsByCoordinate = new Map(
    input.existingRoleVersions.map((version) => [
      `${version.roleDefinitionId}:${version.version}`,
      version,
    ]),
  );
  const existingBehaviorTemplateIds = new Set(input.existingBehaviorTemplateIds ?? []);
  const importedVersions: RoleVersion[] = [];

  for (const template of input.package.roleTemplates ?? []) {
    const existingDefinition = existingDefinitionsById.get(template.definition.id);
    if (existingDefinition) {
      collisions.push({
        kind: 'role_definition',
        importedId: template.definition.id,
        existingId: existingDefinition.id,
        detail: `Role definition id "${template.definition.id}" already exists.`,
        requiresDecision: true,
      });
    }
    for (const version of template.versions) {
      importedVersions.push(version);
      const byId = existingVersionsById.get(version.id);
      if (byId) {
        collisions.push({
          kind: 'role_version_id',
          importedId: version.id,
          existingId: byId.id,
          detail: `Immutable Role version id "${version.id}" already exists.`,
          requiresDecision: true,
        });
      }
      const byCoordinate = existingVersionsByCoordinate.get(
        `${version.roleDefinitionId}:${version.version}`,
      );
      if (byCoordinate && byCoordinate.id !== byId?.id) {
        collisions.push({
          kind: 'role_version_number',
          importedId: version.id,
          existingId: byCoordinate.id,
          detail: `Role version number ${version.version} already exists for this Role.`,
          requiresDecision: true,
        });
      }
      if (byCoordinate) {
        const existingSlots = new Set(byCoordinate.behaviorSlots.map((slot) => slot.key));
        for (const slot of version.behaviorSlots) {
          if (existingSlots.has(slot.key)) {
            collisions.push({
              kind: 'behavior_slot',
              importedId: `${version.id}:${slot.key}`,
              existingId: `${byCoordinate.id}:${slot.key}`,
              detail: `Behavior slot "${slot.key}" collides in Role version ${version.version}.`,
              requiresDecision: true,
            });
          }
        }
      }
    }
  }

  for (const template of input.package.behaviorTemplates ?? []) {
    if (existingBehaviorTemplateIds.has(template.id)) {
      collisions.push({
        kind: 'behavior_template',
        importedId: template.id,
        existingId: template.id,
        detail: `Behavior template id "${template.id}" already exists.`,
        requiresDecision: true,
      });
    }
  }

  const capabilityResolutions: RolePackageImportPlan['capabilityResolutions'] = importedVersions.map(
    (version) => ({
      targetType: 'role_version',
      targetId: version.id,
      resolution: resolveRoleCapabilities({
        requirements: {
          semantic: [
            ...(version.capabilityRequirements?.semantic ?? []),
            ...version.behaviorSlots.flatMap((slot) => slot.requiredCapabilities ?? []),
          ],
          preferredMcpServers: version.capabilityRequirements?.preferredMcpServers,
        },
        providers: input.providers,
        selectedBindings: input.selectedBindings?.[version.id],
      }),
    }),
  );
  for (const template of input.package.behaviorTemplates ?? []) {
    capabilityResolutions.push({
      targetType: 'behavior_template',
      targetId: template.id,
      resolution: resolveRoleCapabilities({
        requirements: { semantic: template.requiredCapabilities ?? [] },
        providers: input.providers,
        selectedBindings: input.selectedBindings?.[template.id],
      }),
    });
  }

  const installedServerNames = new Set(input.providers.map((provider) => provider.name));
  const flowBindingRequirements: RolePackageImportPlan['flowBindingRequirements'] = [];
  for (const version of importedVersions) {
    for (const slot of version.behaviorSlots) {
      const requiredServerNames = collectFlowReferences(slot.flowTemplate).mcpServerNames ?? [];
      flowBindingRequirements.push({
        templateId: `${version.id}:${slot.key}`,
        requiredServerNames,
        missingServerNames: requiredServerNames.filter(
          (serverName) => !installedServerNames.has(serverName),
        ),
      });
    }
  }
  for (const template of input.package.behaviorTemplates ?? []) {
    const requiredServerNames = collectFlowReferences(template.flowTemplate).mcpServerNames ?? [];
    flowBindingRequirements.push({
      templateId: template.id,
      requiredServerNames,
      missingServerNames: requiredServerNames.filter(
        (serverName) => !installedServerNames.has(serverName),
      ),
    });
  }

  const importedByDefinition = new Map<string, RoleVersion[]>();
  for (const version of importedVersions) {
    const current = importedByDefinition.get(version.roleDefinitionId) ?? [];
    current.push(version);
    importedByDefinition.set(version.roleDefinitionId, current);
  }

  const upgrades: PersonaRoleUpgrade[] = [];
  for (const persona of input.existingPersonas) {
    const pinned = existingVersionsById.get(persona.roleVersionId);
    if (!pinned) continue;
    const newest = (importedByDefinition.get(pinned.roleDefinitionId) ?? [])
      .filter((version) => version.version > pinned.version)
      .sort((left, right) => right.version - left.version)[0];
    if (!newest) continue;
    upgrades.push({
      personaId: persona.id,
      roleDefinitionId: pinned.roleDefinitionId,
      fromRoleVersionId: pinned.id,
      toRoleVersionId: newest.id,
      requiresExplicitRepin: true,
    });
  }

  const unresolvedCapabilities = capabilityResolutions.some(
    ({ resolution }) => !resolution.ready,
  );
  const missingFlowBindings = flowBindingRequirements.some(
    ({ missingServerNames }) => missingServerNames.length > 0,
  );
  return {
    collisions,
    capabilityResolutions,
    flowBindingRequirements,
    upgrades,
    requiresReview: collisions.length > 0
      || upgrades.length > 0
      || unresolvedCapabilities
      || missingFlowBindings,
    readyToImport: collisions.length === 0
      && !unresolvedCapabilities
      && !missingFlowBindings,
    personasRemainPinned: true,
  };
}
