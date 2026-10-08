import type { CreateMeetingInput } from '@/shared/types/meeting';

const LAUNCH_KIND_PARAM = 'new';
const PERSONA_ID_PARAM = 'personaId';
const PERSONA_NAME_PARAM = 'personaName';

export function personaMeetingPath(persona: { id: string; name: string }): string {
  const params = new URLSearchParams({
    [LAUNCH_KIND_PARAM]: 'persona',
    [PERSONA_ID_PARAM]: persona.id,
    [PERSONA_NAME_PARAM]: persona.name,
  });
  return `/meetings?${params.toString()}`;
}

export function parseMeetingLaunchIntent(search: string): CreateMeetingInput | null {
  const params = new URLSearchParams(search);
  if (params.get(LAUNCH_KIND_PARAM) !== 'persona') return null;
  const personaId = params.get(PERSONA_ID_PARAM)?.trim();
  if (!personaId) return null;
  const personaName = params.get(PERSONA_NAME_PARAM)?.trim() || 'Persona';
  return {
    title: '',
    openingPrompt: '',
    participants: [{ personaId, name: personaName }],
  };
}

export function clearMeetingLaunchIntent(url: URL): void {
  url.searchParams.delete(LAUNCH_KIND_PARAM);
  url.searchParams.delete(PERSONA_ID_PARAM);
  url.searchParams.delete(PERSONA_NAME_PARAM);
}
