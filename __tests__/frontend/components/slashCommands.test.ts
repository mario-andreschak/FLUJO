import {
  SLASH_COMMANDS,
  filterSlashCommands,
  findSlashQuery,
  literalSlashText,
  parseSlashCommand,
} from '@/frontend/components/Chat/slashCommands';
import { translate } from '@/frontend/i18n/core';
import { SUPPORTED_LOCALES } from '@/frontend/i18n/locales';

describe('slash command parsing (#1225)', () => {
  it('recognizes a known command at the start, with or without text after it', () => {
    expect(parseSlashCommand('/compact')?.command.id).toBe('compact');
    expect(parseSlashCommand('  /status  ')?.command.id).toBe('status');
    expect(parseSlashCommand('/Goal Ship the release')).toMatchObject({
      command: { id: 'goal' }, args: 'Ship the release',
    });
    expect(parseSlashCommand('/goal first line\nsecond line')?.args).toBe('first line\nsecond line');
    expect(parseSlashCommand('/goal')).toMatchObject({ command: { id: 'goal' }, args: '' });
  });

  it('never swallows ordinary text that only looks like a command', () => {
    expect(parseSlashCommand('/unknown thing')).toBeNull();
    expect(parseSlashCommand('/usr/bin/env node')).toBeNull();
    expect(parseSlashCommand('/compactly please')).toBeNull();
    expect(parseSlashCommand('please /compact')).toBeNull();
    // A command without text keeps any text as a message instead of dropping it.
    expect(parseSlashCommand('/new chat about cats')).toBeNull();
    expect(parseSlashCommand('//goal literal')).toBeNull();
  });

  it('sends a doubled slash in front of a command as the plain command text', () => {
    expect(literalSlashText('//goal is a word')).toBe('/goal is a word');
    expect(literalSlashText('  //compact')).toBe('  /compact');
    expect(literalSlashText('// a code comment')).toBeNull();
    expect(literalSlashText('//server/share')).toBeNull();
    expect(literalSlashText('/goal x')).toBeNull();
  });

  it('opens the menu only while the message is a slash and one word', () => {
    expect(findSlashQuery('/')).toBe('');
    expect(findSlashQuery('/Co')).toBe('co');
    expect(findSlashQuery('/goal ')).toBeNull();
    expect(findSlashQuery('hello /co')).toBeNull();
    expect(findSlashQuery('/co\n')).toBeNull();
  });

  it('lists name matches first, then description matches', () => {
    const describe = (command: (typeof SLASH_COMMANDS)[number]) => translate('en', command.description);
    expect(filterSlashCommands(SLASH_COMMANDS, '').map(c => c.id)).toEqual(SLASH_COMMANDS.map(c => c.id));
    expect(filterSlashCommands(SLASH_COMMANDS, 'co', describe).map(c => c.id)).toEqual(['compact', 'context']);
    expect(filterSlashCommands(SLASH_COMMANDS, 'summar', describe).map(c => c.id)).toEqual(['compact']);
    expect(filterSlashCommands(SLASH_COMMANDS, 'zzz', describe)).toEqual([]);
  });

  it('describes every command in every language the app ships', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const command of SLASH_COMMANDS) {
        expect(translate(locale.code, command.description)).not.toBe(command.description);
        if (command.argsHint) expect(translate(locale.code, command.argsHint)).not.toBe(command.argsHint);
      }
    }
  });
});
