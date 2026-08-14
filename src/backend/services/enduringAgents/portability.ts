import {
  PersonaSchema,
  RoleDefinitionSchema,
  RoleVersionSchema,
  type Persona,
  type RoleDefinition,
  type RoleVersion,
} from '@/shared/types/enduringAgent';
import {
  packagedBehaviorTemplateSchema,
  packagedPersonaTemplateSchema,
  type PackagedBehaviorTemplate,
  type PackagedPersonaTemplate,
  type PackagedRoleTemplate,
} from '@/shared/types/package';

/**
 * Build the portable part of the Persona export exposed in Settings. The
 * allow-list is intentional: private memory, conversations, accounts, and
 * runtime state never cross this boundary.
 *
 * Draft generation, import planning, and provider binding are not product
 * capabilities here. They must be introduced together with their review UI,
 * public route, and recovery path rather than living as callable backend-only
 * workflows.
 */
export function buildAgentConfigurationExport(input: {
  roleDefinition: RoleDefinition;
  roleVersions: RoleVersion[];
  persona?: Persona;
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
