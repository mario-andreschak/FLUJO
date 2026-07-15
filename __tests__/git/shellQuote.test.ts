/**
 * Unit tests for the shared shell-argument quoting used by the /api/git command
 * runners (issue #105).
 *
 * The runners execute a base command string through a shell (execSync -> /bin/sh or
 * cmd; spawn({shell:true})). The base command is intentionally a (possibly compound)
 * shell string and is left un-quoted; only appended `args` are shell-quoted so a
 * metacharacter in an arg reaches the child as ONE literal token instead of being
 * interpreted by the shell. Both platform branches are exercised via the injectable
 * `platform` parameter so they run regardless of the CI host.
 */

import {
  posixQuoteArg,
  windowsQuoteArg,
  shellQuoteArg,
  buildRepoCommand,
} from '@/utils/git/validation';

describe('posixQuoteArg', () => {
  it('wraps every arg in single quotes so shell metacharacters are inert', () => {
    expect(posixQuoteArg('; touch pwned')).toBe(`'; touch pwned'`);
    expect(posixQuoteArg('$(id)')).toBe(`'$(id)'`);
    expect(posixQuoteArg('`id`')).toBe("'`id`'");
    expect(posixQuoteArg('a && b')).toBe(`'a && b'`);
    expect(posixQuoteArg('--json={"a": 1}')).toBe(`'--json={"a": 1}'`);
  });

  it('escapes an embedded single quote by closing, escaping, then reopening', () => {
    // "a'b" -> '<a>'\''<b>' : the classic POSIX close-quote / escaped-quote / reopen.
    expect(posixQuoteArg("a'b")).toBe(`'a'\\''b'`);
  });
});

describe('windowsQuoteArg', () => {
  it('wraps in double quotes so cmd metacharacters become literal, as one token', () => {
    expect(windowsQuoteArg('a & b')).toBe('"a & b"');
    expect(windowsQuoteArg('a|b')).toBe('"a|b"');
    expect(windowsQuoteArg('a>b')).toBe('"a>b"');
    expect(windowsQuoteArg('a^b')).toBe('"a^b"');
  });

  it('doubles embedded double quotes and preserves spaces', () => {
    expect(windowsQuoteArg('a"b')).toBe('"a""b"');
    expect(windowsQuoteArg('a b')).toBe('"a b"');
  });
});

describe('shellQuoteArg (platform dispatch)', () => {
  it('uses POSIX single-quoting on linux', () => {
    expect(shellQuoteArg('; touch pwned', 'linux')).toBe(`'; touch pwned'`);
    expect(shellQuoteArg('$(id)', 'linux')).toBe(`'$(id)'`);
  });

  it('uses cmd double-quoting on win32', () => {
    expect(shellQuoteArg('a & calc', 'win32')).toBe('"a & calc"');
  });
});

describe('buildRepoCommand', () => {
  it('passes a benign base command through unchanged when there are no args', () => {
    expect(buildRepoCommand('git pull', undefined, 'linux')).toBe('git pull');
    expect(buildRepoCommand('npm install', [], 'linux')).toBe('npm install');
    // Compound commands must keep working (base string is never quoted).
    expect(buildRepoCommand('npm install && npm run build', undefined, 'linux')).toBe(
      'npm install && npm run build'
    );
  });

  it('quotes each appended arg as one literal token (POSIX)', () => {
    expect(buildRepoCommand('npm run', ['start', '; rm -rf /'], 'linux')).toBe(
      `npm run 'start' '; rm -rf /'`
    );
  });

  it('quotes each appended arg as one literal token (Windows)', () => {
    expect(buildRepoCommand('npm run', ['start', '& calc'], 'win32')).toBe(
      'npm run "start" "& calc"'
    );
  });

  it('filters out empty / whitespace-only args', () => {
    expect(buildRepoCommand('cmd', ['', '  ', 'real'], 'linux')).toBe(`cmd 'real'`);
  });

  it('does not interpret a metacharacter arg as a command separator', () => {
    // The dangerous ";" and its payload end up inside a single quoted token, so the
    // shell sees one argument, never a second command.
    const result = buildRepoCommand('echo hi', ['; touch pwned'], 'linux');
    expect(result).toBe(`echo hi '; touch pwned'`);
    expect(result).not.toMatch(/echo hi ; touch/);
  });
});
