/**
 * Shell-dialect trap detection, output caps and stream decoding for the built-in
 * `bash` MCP server (issue #364). These are pure helpers: no process is spawned.
 */
import {
  detectDialectMismatch,
  detectInteractiveHangRisk,
  commandUsesPosixChaining,
  createStreamDecoder,
  wrapPowerShellCommand,
  wrapCmdCommand,
} from '@/backend/services/mcp/internal/bashTools';

const noneAvailable = () => false;
const allAvailable = () => true;

describe('detectDialectMismatch', () => {
  it('flags && / || under Windows PowerShell 5.1 only', () => {
    const warnings = detectDialectMismatch('git fetch && git status', 'powershell', allAvailable);
    expect(warnings.join(' ')).toMatch(/not statement separators in Windows PowerShell 5\.1/);
    expect(detectDialectMismatch('git fetch && git status', 'pwsh', allAvailable)).toEqual([]);
    expect(detectDialectMismatch('git fetch && git status', 'bash', allAvailable)).toEqual([]);
  });

  it('does not flag operators that only appear inside quoted strings', () => {
    expect(detectDialectMismatch('Write-Output "a && b"', 'powershell', allAvailable)).toEqual([]);
    expect(detectDialectMismatch("echo 'x || y'", 'bash', allAvailable)).toEqual([]);
  });

  it('flags POSIX utilities that are not installed, and stays silent when they are', () => {
    const missing = detectDialectMismatch('ffmpeg -version | head -2', 'powershell', noneAvailable);
    expect(missing.join(' ')).toMatch(/"head" is a POSIX utility/);
    expect(detectDialectMismatch('ffmpeg -version | head -2', 'powershell', allAvailable)).toEqual([]);
  });

  it('warns about missing rg and arbitrary command heads, including pipeline stages', () => {
    const warnings = detectDialectMismatch('rg -n needle . | head -1; custom-tool --version', 'cmd', noneAvailable);
    expect(warnings.join(' ')).toMatch(/"rg" is a POSIX utility/);
    expect(warnings.join(' ')).toMatch(/"head" is a POSIX utility/);
    expect(warnings.join(' ')).toMatch(/"custom-tool" was not found on PATH/);
  });

  it('does not mistake builtins, assignments, paths, or PowerShell cmdlets for executables', () => {
    expect(detectDialectMismatch('$p="x"; Get-ChildItem .; dir', 'powershell', noneAvailable)).toEqual([]);
  });

  it('flags backtick substitution and redundant 2>&1 under PowerShell', () => {
    expect(detectDialectMismatch('echo `date`', 'pwsh', allAvailable).join(' '))
      .toMatch(/Backticks are the line-continuation/);
    expect(detectDialectMismatch('ffmpeg -i in.mp4 2>&1', 'pwsh', allAvailable).join(' '))
      .toMatch(/already merges stdout and stderr/);
  });

  it('flags single quotes and command substitution under cmd', () => {
    const warnings = detectDialectMismatch("echo 'hi' && echo $(date)", 'cmd', allAvailable);
    expect(warnings.join(' ')).toMatch(/single quotes/);
    expect(warnings.join(' ')).toMatch(/Command substitution/);
  });

  it('flags PowerShell cmdlets running under a POSIX shell', () => {
    expect(detectDialectMismatch('Get-ChildItem -Recurse', 'bash', allAvailable).join(' '))
      .toMatch(/PowerShell cmdlet/);
  });

  it('produces no warnings for ordinary bash commands', () => {
    for (const command of ['ls -la', 'grep -rn foo src | wc -l', 'node -e "console.log(1)"']) {
      expect(detectDialectMismatch(command, 'bash', allAvailable)).toEqual([]);
    }
  });
});

describe('commandUsesPosixChaining', () => {
  it('ignores chaining inside quotes', () => {
    expect(commandUsesPosixChaining('a && b')).toBe(true);
    expect(commandUsesPosixChaining('echo "a && b"')).toBe(false);
  });
});

describe('detectInteractiveHangRisk', () => {
  it('hints at pagers and interactive prompts', () => {
    expect(detectInteractiveHangRisk('git log -5').join(' ')).toMatch(/--no-pager/);
    expect(detectInteractiveHangRisk('git --no-pager log -5')).toEqual([]);
    expect(detectInteractiveHangRisk('cat file | less').join(' ')).toMatch(/interactive pagers/);
    expect(detectInteractiveHangRisk('Get-Process | Format-Table').join(' ')).toMatch(/Out-String/);
  });
});

describe('createStreamDecoder', () => {
  it('decodes UTF-16LE with a BOM under "auto"', () => {
    const decode = createStreamDecoder('auto');
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello wörld', 'utf16le')]);
    expect(decode(buf)).toBe('hello wörld');
  });

  it('detects BOM-less UTF-16LE from its NUL ratio', () => {
    const decode = createStreamDecoder('auto');
    expect(decode(Buffer.from('ffmpeg version', 'utf16le'))).toBe('ffmpeg version');
  });

  it('keeps plain UTF-8 intact and strips a UTF-8 BOM', () => {
    expect(createStreamDecoder('auto')(Buffer.from('grüße', 'utf8'))).toBe('grüße');
    expect(createStreamDecoder('auto')(Buffer.from('﻿plain', 'utf8'))).toBe('plain');
  });

  it('honours an explicit encoding', () => {
    expect(createStreamDecoder('utf8')(Buffer.from('abc'))).toBe('abc');
  });
});

describe('shell command wrapping', () => {
  it('forces UTF-8, invariant culture and native exit codes for PowerShell', () => {
    const wrapped = wrapPowerShellCommand('ffmpeg -version');
    expect(wrapped).toContain("$ErrorActionPreference='Continue'");
    expect(wrapped).toContain('OutputEncoding');
    expect(wrapped).toContain('InvariantCulture');
    expect(wrapped).toContain('ffmpeg -version');
    expect(wrapped).toContain('exit $(if ($null -ne $LASTEXITCODE)');
  });

  it('forces the UTF-8 code page for cmd', () => {
    expect(wrapCmdCommand('dir')).toBe('chcp 65001>nul & dir');
  });
});
