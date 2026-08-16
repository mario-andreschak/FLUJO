import { personasMessageRows } from '@/frontend/i18n/catalogs/personas';

describe('Persona creation copy', () => {
  it('keeps beginner-facing wizard copy free of runtime vocabulary', () => {
    const copy = Object.entries(personasMessageRows)
      .filter(([key]) => key.startsWith('personas.create.'))
      .flatMap(([, translations]) => translations)
      .join(' ');

    expect(copy).not.toMatch(
      /\b(grants?|polic(?:y|ies)|identit(?:y|ies)|revisions?|durable commitments?|capability intersections?|schemas?)\b/i,
    );
  });
});
