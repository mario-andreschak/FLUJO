import { createHash } from 'node:crypto';

import {
  PersonaExportPreviewSchema,
  PersonaExportSelectionSchema,
  PERSONA_EXPORT_EXCLUDED_CATEGORIES,
  type PersonaExportPreview,
  type PersonaExportSelection,
} from '@/shared/types/enduringAgent';
import { serializePackage } from '@/shared/types/package';

import { buildAgentConfigurationExport } from './portability';
import {
  getPersona,
  getRoleDefinition,
  getRoleVersion,
  listRoleVersions,
} from './store';

export class PersonaConfigurationExportNotFoundError extends Error {}

function safeSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase();
  return slug || 'persona';
}

async function buildPersonaConfigurationArtifact(
  personaId: string,
  value: unknown,
): Promise<{
  json: string;
  preview: PersonaExportPreview;
  selection: PersonaExportSelection;
}> {
  const selection = PersonaExportSelectionSchema.parse(value);
  const persona = await getPersona(personaId);
  if (!persona) {
    throw new PersonaConfigurationExportNotFoundError('Persona not found.');
  }
  const pinnedVersion = await getRoleVersion(persona.roleVersionId);
  if (!pinnedVersion) {
    throw new PersonaConfigurationExportNotFoundError(
      'The Persona\'s pinned Role version was not found.',
    );
  }
  const roleDefinition = await getRoleDefinition(pinnedVersion.roleDefinitionId);
  if (!roleDefinition) {
    throw new PersonaConfigurationExportNotFoundError(
      'The Persona\'s Role was not found.',
    );
  }
  const roleVersions = await listRoleVersions(roleDefinition.id);
  const configuration = buildAgentConfigurationExport({
    roleDefinition,
    roleVersions,
    persona,
  });
  const slug = safeSlug(persona.name);
  const filename = `${slug}-configuration.flujo.json`;
  const serialized = serializePackage({
    id: `${slug}-configuration`,
    name: `${persona.name} configuration`,
    version: '1.0.0',
    description: 'Privacy-safe Persona configuration export.',
    tags: ['persona', 'configuration'],
    roleTemplates: configuration.roleTemplates,
    behaviorTemplates: configuration.behaviorTemplates,
    personaTemplates: configuration.personaTemplates,
  });
  const bytes = Buffer.byteLength(serialized.json, 'utf8');
  const sha256 = createHash('sha256').update(serialized.json).digest('hex');

  return {
    json: serialized.json,
    selection,
    preview: PersonaExportPreviewSchema.parse({
      personaId: persona.id,
      generatedAt: Date.now(),
      selection,
      included: {
        roleTemplates: configuration.roleTemplates.length,
        roleVersions: configuration.roleTemplates.reduce(
          (count, template) => count + template.versions.length,
          0,
        ),
        behaviorTemplates: configuration.behaviorTemplates.length,
        personaTemplates: configuration.personaTemplates.length,
      },
      excluded: PERSONA_EXPORT_EXCLUDED_CATEGORIES,
      privacyWarnings: [
        'configuration_only',
        'shared_resources_referenced_not_copied',
      ],
      artifact: {
        filename,
        contentType: 'application/json',
        sha256,
        bytes,
      },
    }),
  };
}

export async function previewPersonaConfigurationExport(
  personaId: string,
  value: unknown,
): Promise<PersonaExportPreview> {
  return (await buildPersonaConfigurationArtifact(personaId, value)).preview;
}

export async function exportPersonaConfiguration(
  personaId: string,
  value: unknown,
): Promise<{ json: string; preview: PersonaExportPreview }> {
  const artifact = await buildPersonaConfigurationArtifact(personaId, value);
  return { json: artifact.json, preview: artifact.preview };
}
