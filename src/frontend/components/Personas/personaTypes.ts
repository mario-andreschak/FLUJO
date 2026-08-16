export const PERSONA_AREAS = [
  'overview',
  'setup',
  'memory',
  'conversations',
  'tasks',
  'improvements',
  'settings',
] as const;

export type PersonaArea = (typeof PERSONA_AREAS)[number];
export type PersonaAreaSubsection = 'behaviors' | 'apps' | 'history' | null;

export interface NormalizedPersonaArea {
  area: PersonaArea;
  subsection: PersonaAreaSubsection;
  shouldCanonicalize: boolean;
}

const LEGACY_AREA_ALIASES: Record<string, {
  area: PersonaArea;
  subsection: PersonaAreaSubsection;
}> = {
  now: { area: 'overview', subsection: null },
  talk: { area: 'conversations', subsection: null },
  work: { area: 'tasks', subsection: null },
  behaviors: { area: 'setup', subsection: 'behaviors' },
  apps: { area: 'setup', subsection: 'apps' },
  activity: { area: 'settings', subsection: 'history' },
};

export function normalizePersonaArea(value: string | null): NormalizedPersonaArea {
  if (value && (PERSONA_AREAS as readonly string[]).includes(value)) {
    return {
      area: value as PersonaArea,
      subsection: null,
      shouldCanonicalize: false,
    };
  }
  const alias = value ? LEGACY_AREA_ALIASES[value] : undefined;
  if (alias) {
    return { ...alias, shouldCanonicalize: true };
  }
  return {
    area: 'overview',
    subsection: null,
    shouldCanonicalize: value !== null && value !== 'overview',
  };
}
