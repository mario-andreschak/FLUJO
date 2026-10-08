import { personasMessageRows } from '@/frontend/i18n/catalogs/personas';
import { rolesMessageRows } from '@/frontend/i18n/catalogs/roles';
import { settingsMessageRows } from '@/frontend/i18n/catalogs/settings';
import { mcpMessageRows } from '@/frontend/i18n/catalogs/mcp';
import { chatMessageRows } from '@/frontend/i18n/catalogs/chat';

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

  it('preserves interpolation fields and supplies localized Persona and Role copy', () => {
    const rows = [
      ...Object.entries(rolesMessageRows),
      ...Object.entries(personasMessageRows),
      ...Object.entries(mcpMessageRows).filter(([key]) => key.startsWith('mcp.presets.')),
      ...Object.entries(chatMessageRows).filter(([key]) => key.startsWith('chat.page.loading')),
      ...Object.entries(settingsMessageRows).filter(([key]) => key.startsWith('settings.personaRecovery.') || key === 'settings.backup.personaScope'),
    ];
    const fields = (message: string) => [...message.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
    for (const [key, row] of rows) {
      expect({ key, translations: row.length }).toEqual({ key, translations: 7 });
      for (const message of row) {
        expect(message.trim()).not.toBe('');
        expect({ key, fields: fields(message) }).toEqual({ key, fields: fields(row[0]) });
      }
      // Pure interpolation rows intentionally have no language-specific text.
      if (['personas.role', 'personas.history.when'].includes(key)) continue;
      // Chinese shares no complete UI message in this surface with English.
      // This catches a silent all-English row, unlike key-presence checks.
      expect({ key, translated: row[6] !== row[0] }).toEqual({ key, translated: true });
    }
  });
});
