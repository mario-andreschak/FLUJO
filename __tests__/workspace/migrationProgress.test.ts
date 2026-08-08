import {
  createMigrationProgressReporter,
  shouldUseInteractiveMigrationUI,
} from '@/backend/services/workspace/migrationProgress';

class MemoryTerminal {
  readonly chunks: string[] = [];
  isTTY = true;
  columns = 120;
  hasColors = () => false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  output(): string {
    return this.chunks.join('');
  }
}

describe('workspace migration progress renderer', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('preserves structured line logs in plain mode', () => {
    const info: string[] = [];
    const error: string[] = [];
    const reporter = createMigrationProgressReporter({
      interactive: false,
      info: line => info.push(line),
      error: line => error.push(line),
    });

    reporter.report('inventory progress', {
      purpose: 'preflight source for db',
      files: 12,
      bytes: '4.00 KiB',
    });
    reporter.report(
      'FAILED - no conflicting data was overwritten',
      { code: 'WORKSPACE_MIGRATION_CONFLICT', error: 'destination differs' },
      'error',
    );

    expect(info).toEqual([
      '[FLUJO] Workspace migration: inventory progress | purpose="preflight source for db" files=12 bytes="4.00 KiB"',
    ]);
    expect(error).toEqual([
      '[FLUJO] Workspace migration: FAILED - no conflicting data was overwritten | code="WORKSPACE_MIGRATION_CONFLICT" error="destination differs"',
    ]);
  });

  it('renders animated milestones and stops repainting after success', () => {
    jest.useFakeTimers();
    const terminal = new MemoryTerminal();
    const reporter = createMigrationProgressReporter({
      interactive: true,
      stream: terminal,
      colors: false,
      ascii: true,
      animationIntervalMs: 40,
    });

    reporter.report('started', { version: 2, dataRoot: 'C:\\data' });
    reporter.report('exclusive lock acquired');
    reporter.report('preflight candidate', { position: '3/11', subtree: 'userdata' });

    expect(terminal.output()).toContain('F L U J O');
    expect(terminal.output()).toContain('where ideas find their flow');
    expect(terminal.output()).toContain('o/--------.');
    expect(terminal.output()).toContain('<__\\o/__>');
    expect(terminal.output()).toContain('Workspace migration v2 - Data: C:\\data');
    expect(terminal.output()).toContain('[ok] Migration lock acquired');
    expect(terminal.output()).toContain('Preflight 3/11 - userdata');
    expect(terminal.output()).not.toContain('·');

    const writesBeforeAnimation = terminal.chunks.length;
    jest.advanceTimersByTime(120);
    expect(terminal.chunks.length).toBeGreaterThan(writesBeforeAnimation);
    const runnerFrames = terminal.chunks
      .slice(writesBeforeAnimation)
      .filter(chunk => chunk.includes('^..^>'));
    expect(new Set(runnerFrames).size).toBeGreaterThan(1);

    reporter.report('finished successfully', { elapsed: '1.2s' });
    expect(terminal.output()).toContain('[ok] Workspace migration complete - 1.2s');
    const writesAfterFinish = terminal.chunks.length;
    jest.advanceTimersByTime(200);
    expect(terminal.chunks).toHaveLength(writesAfterFinish);
  });

  it('sanitizes control characters in terminal-facing errors', () => {
    const terminal = new MemoryTerminal();
    const reporter = createMigrationProgressReporter({
      interactive: true,
      stream: terminal,
      colors: false,
      ascii: true,
    });

    reporter.report('started', { version: 2 });
    reporter.report(
      'FAILED - no conflicting data was overwritten',
      { error: 'unsafe\u001B[2J\nmessage' },
      'error',
    );

    expect(terminal.output()).not.toContain('unsafe\u001B[2J');
    expect(terminal.output()).toContain('unsafe�[2J�message');
  });

  it('uses the compact presentation when the terminal is too narrow for the landscape', () => {
    const terminal = new MemoryTerminal();
    terminal.columns = 60;
    const reporter = createMigrationProgressReporter({
      interactive: true,
      stream: terminal,
      colors: false,
    });

    reporter.report('started', { version: 2, dataRoot: '/data' });
    reporter.report('finished successfully', { elapsed: '0.2s' });

    expect(terminal.output()).toContain('FLUJO · Workspace migration v2');
    expect(terminal.output()).toContain('Data: /data');
    expect(terminal.output()).not.toContain('where ideas find their flow');
    expect(terminal.output()).not.toContain('<__\\o/__>');
  });

  it('colors the title, activity indicator, and successful result when supported', () => {
    const terminal = new MemoryTerminal();
    const reporter = createMigrationProgressReporter({
      interactive: true,
      stream: terminal,
      colors: true,
    });

    reporter.report('started', { version: 2 });
    reporter.report('finished successfully', { elapsed: '0.2s' });

    expect(terminal.output()).toMatch(/\u001B\[1m\u001B\[35m +F L U J O/);
    expect(terminal.output()).toContain('\u001B[36m⠋\u001B[0m');
    expect(terminal.output()).toContain('\u001B[32m✓\u001B[0m');
  });

  it('uses animation only for capable terminals unless explicitly forced', () => {
    const tty = { isTTY: true, write: () => true };
    const pipe = { isTTY: false, write: () => true };

    expect(shouldUseInteractiveMigrationUI(tty, {})).toBe(true);
    expect(shouldUseInteractiveMigrationUI(tty, { CI: 'true' })).toBe(false);
    expect(shouldUseInteractiveMigrationUI(tty, { TERM: 'dumb' })).toBe(false);
    expect(shouldUseInteractiveMigrationUI(tty, { FLUJO_MIGRATION_UI: 'plain' })).toBe(false);
    expect(shouldUseInteractiveMigrationUI(pipe, { FLUJO_MIGRATION_UI: 'tty' })).toBe(true);
  });
});
