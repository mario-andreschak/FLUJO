import { EventEmitter } from 'node:events';
import {
  createMigrationProgressReporter,
  shouldUseFullscreenMigrationUI,
  shouldUseInteractiveMigrationUI,
} from '@/backend/services/workspace/migrationProgress';
import {
  migrationLandscapeMotion,
  migrationLandscapeThemeForLocalHour,
} from '@/backend/services/workspace/migrationLandscape';

class MemoryTerminal {
  readonly chunks: string[] = [];
  isTTY = true;
  columns = 120;
  rows = 30;
  hasColors = () => false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  output(): string {
    return this.chunks.join('');
  }
}

class MemoryInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;

  isPaused(): boolean {
    return this.paused;
  }

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
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
      _bytes: 4096,
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

  it('uses the interactive UI by default only for capable attached terminals', () => {
    const tty = { isTTY: true, write: () => true };
    const pipe = { isTTY: false, write: () => true };

    expect(shouldUseInteractiveMigrationUI(tty, {})).toBe(true);
    expect(shouldUseInteractiveMigrationUI(tty, { CI: 'true' })).toBe(false);
    expect(shouldUseInteractiveMigrationUI(tty, { TERM: 'dumb' })).toBe(false);
    expect(shouldUseInteractiveMigrationUI(tty, { FLUJO_MIGRATION_UI: 'plain' })).toBe(false);
    expect(shouldUseInteractiveMigrationUI(pipe, {})).toBe(false);
    expect(shouldUseInteractiveMigrationUI(pipe, { FLUJO_MIGRATION_UI: 'tty' })).toBe(true);
  });

  it('selects the landscape from local time and bounds telemetry-driven motion', () => {
    expect(migrationLandscapeThemeForLocalHour(6)).toBe('daybreak');
    expect(migrationLandscapeThemeForLocalHour(18)).toBe('twilight');
    expect(migrationLandscapeThemeForLocalHour(23)).toBe('moonlight');
    expect(migrationLandscapeThemeForLocalHour(-1)).toBe('moonlight');

    const idle = migrationLandscapeMotion({
      bytesPerSecond: 0,
      filesPerSecond: 0,
      progress: 0,
    });
    const busy = migrationLandscapeMotion({
      bytesPerSecond: 250 * 1024 * 1024,
      filesPerSecond: 20_000,
      progress: 1,
    });

    expect(busy.riverSpeed).toBeGreaterThan(idle.riverSpeed);
    expect(busy.actorSpeed).toBeGreaterThan(idle.actorSpeed);
    expect(busy.panningSpeed).toBeGreaterThan(idle.panningSpeed);
    expect(busy.mountainHeightScale).toBeGreaterThan(idle.mountainHeightScale);
    expect(busy.riverSpeed).toBeLessThanOrEqual(3);
    expect(busy.mountainHeightScale).toBeLessThanOrEqual(1.08);
  });

  it('uses the fullscreen landscape only when color and dimensions support it', () => {
    const terminal = new MemoryTerminal();
    terminal.hasColors = () => true;

    expect(shouldUseFullscreenMigrationUI(terminal, {})).toBe(true);
    expect(shouldUseFullscreenMigrationUI(terminal, { FLUJO_MIGRATION_UI: 'landscape' })).toBe(true);
    expect(shouldUseFullscreenMigrationUI(terminal, { NO_COLOR: '1' })).toBe(false);
    expect(shouldUseFullscreenMigrationUI(terminal, { FLUJO_MIGRATION_UI: 'compact' })).toBe(false);
    terminal.rows = 17;
    expect(shouldUseFullscreenMigrationUI(terminal, { FLUJO_MIGRATION_UI: 'landscape' })).toBe(false);
  });

  it('renders actual migration telemetry in the fullscreen landscape and restores the terminal', () => {
    const terminal = new MemoryTerminal();
    terminal.columns = 90;
    terminal.rows = 24;
    terminal.hasColors = () => true;
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const reporter = createMigrationProgressReporter({
      interactive: true,
      fullscreen: true,
      stream: terminal,
      colors: true,
      trueColor: false,
    });

    reporter.report('started', { version: 2, dataRoot: 'C:\\data' });
    reporter.report('inventory started', {
      purpose: 'preflight source for db',
      content: 'sha256',
      _bytes: 0,
    });
    now.mockReturnValue(6_000);
    reporter.report('inventory progress', {
      purpose: 'preflight source for db',
      content: 'sha256',
      files: 500,
      directories: 20,
      bytes: '40.0 MiB',
      _bytes: 40 * 1024 * 1024,
      elapsed: '5.0s',
    });
    reporter.report('finished successfully', { elapsed: '5.2s' });

    expect(terminal.output()).toContain('\u001B[?1049h');
    expect(terminal.output()).toContain("We're making things better for you.");
    expect(terminal.output()).toContain('Scanning legacy db');
    expect(terminal.output()).toContain('500 files · 20 dirs · 40.0 MiB · 5.0s');
    expect(terminal.output()).toContain('Reading  8.00 MiB/s  ·  100 files/s');
    expect(terminal.output()).toContain('\u001B[?1049l');
    expect(terminal.output()).toContain('Workspace migration complete · 5.2s');
    now.mockRestore();
  });

  it.each(['q', '\u001B'])('switches from the landscape to durable logs when %p is pressed', key => {
    const terminal = new MemoryTerminal();
    const input = new MemoryInput();
    terminal.columns = 90;
    terminal.rows = 24;
    terminal.hasColors = () => true;
    const reporter = createMigrationProgressReporter({
      interactive: true,
      fullscreen: true,
      stream: terminal,
      input,
      colors: true,
      trueColor: false,
    });

    reporter.report('started', { version: 2, dataRoot: 'C:\\data' });
    reporter.report('inventory progress', {
      purpose: 'preflight source for db',
      files: 12,
      bytes: '4.00 KiB',
    });
    expect(input.isRaw).toBe(true);
    expect(input.isPaused()).toBe(false);

    input.emit('data', key);

    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(terminal.output()).toContain('\u001B[?1049l');
    expect(terminal.output()).toContain('[FLUJO] Workspace migration: landscape closed; continuing with log output');
    expect(terminal.output()).toContain('[FLUJO] Workspace migration: inventory progress');

    reporter.report('cleanup complete', { entries: 11 });
    reporter.report('finished successfully', { elapsed: '5.2s' });
    expect(terminal.output()).toContain('[FLUJO] Workspace migration: cleanup complete | entries=11');
    expect(terminal.output()).toContain('[FLUJO] Workspace migration: finished successfully | elapsed="5.2s"');
  });
});
