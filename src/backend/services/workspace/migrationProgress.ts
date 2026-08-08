import path from 'node:path';
import { clearLine, cursorTo } from 'node:readline';

export type MigrationProgressDetails = Record<
  string,
  string | number | boolean | undefined
>;

export type MigrationProgressLevel = 'info' | 'error';

interface MigrationTerminalStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
  hasColors?: (count?: number) => boolean;
}

type MigrationEnvironment = Readonly<Record<string, string | undefined>>;

interface MigrationProgressReporter {
  report(
    message: string,
    details?: MigrationProgressDetails,
    level?: MigrationProgressLevel,
  ): void;
  close(): void;
}

export interface MigrationProgressReporterOptions {
  interactive: boolean;
  stream?: MigrationTerminalStream;
  info?: (line: string) => void;
  error?: (line: string) => void;
  colors?: boolean;
  ascii?: boolean;
  animationIntervalMs?: number;
}

const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  cyan: '\u001B[36m',
  magenta: '\u001B[35m',
} as const;

const UNICODE_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const ASCII_SPINNER = ['-', '\\', '|', '/'] as const;
const TERMINAL_EVENT_NAMES = new Set([
  'finished successfully',
  'FAILED - no conflicting data was overwritten',
]);

function style(text: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

/** Strip terminal control characters from filesystem-derived status text. */
function safeTerminalText(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F-\u009F]/g, '�');
}

function stringDetail(details: MigrationProgressDetails, key: string): string | undefined {
  const value = details[key];
  return value === undefined ? undefined : safeTerminalText(value);
}

function formatPlainLine(message: string, details: MigrationProgressDetails): string {
  const fields = Object.entries(details)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  return `[FLUJO] Workspace migration: ${message}${fields ? ` | ${fields}` : ''}`;
}

class PlainMigrationProgressReporter implements MigrationProgressReporter {
  constructor(
    private readonly info: (line: string) => void,
    private readonly error: (line: string) => void,
  ) {}

  report(
    message: string,
    details: MigrationProgressDetails = {},
    level: MigrationProgressLevel = 'info',
  ): void {
    const line = formatPlainLine(message, details);
    if (level === 'error') this.error(line);
    else this.info(line);
  }

  close(): void {}
}

class TtyMigrationProgressReporter implements MigrationProgressReporter {
  private readonly frames: readonly string[];
  private animationTick = 0;
  private liveStatus = '';
  private liveLineRendered = false;
  private animationTimer?: ReturnType<typeof setInterval>;
  private ended = false;
  private scenic = false;

  constructor(
    private readonly stream: MigrationTerminalStream,
    private readonly colors: boolean,
    private readonly ascii: boolean,
    private readonly animationIntervalMs: number,
  ) {
    this.frames = ascii ? ASCII_SPINNER : UNICODE_SPINNER;
  }

  report(
    message: string,
    details: MigrationProgressDetails = {},
    _level: MigrationProgressLevel = 'info',
  ): void {
    if (this.ended && message !== 'started') return;

    switch (message) {
      case 'started':
        this.start(details);
        return;
      case 'exclusive lock acquired':
        this.milestone('Migration lock acquired');
        this.updateStatus('Checking existing workspace state');
        return;
      case 'reclaiming stale migration lock':
        this.milestone('Reclaiming an interrupted migration lock', 'warning');
        this.updateStatus('Recovering workspace state');
        return;
      case 'recovering durable transaction':
        this.milestone(
          `Recovering interrupted migration${stringDetail(details, 'phase') ? `${this.separator()}${stringDetail(details, 'phase')}` : ''}`,
          'warning',
        );
        this.updateStatus('Validating the durable transaction');
        return;
      case 'existing layout marker found':
        this.updateStatus('Validating the existing workspace layout');
        return;
      case 'reconciliation pass':
        this.updateStatus(
          `Checking migration state${this.position(details, 'pass', 'maximum')}`,
        );
        return;
      case 'preflight started':
        this.updateStatus(`Preflight${this.countSuffix(details, 'candidates', 'locations')}`);
        return;
      case 'preflight candidate':
        this.updateStatus(
          `Preflight ${stringDetail(details, 'position') ?? ''}${this.namedSuffix(details, 'subtree')}`.trim(),
        );
        return;
      case 'preflight candidate ready':
        this.updateStatus([
          `Preflight ${stringDetail(details, 'position') ?? ''}`.trim(),
          stringDetail(details, 'subtree'),
          stringDetail(details, 'outcome'),
        ].filter(Boolean).join(this.separator()));
        return;
      case 'preflight complete':
        this.milestone(`Preflight complete${this.countSuffix(details, 'entries', 'locations')}`);
        this.updateStatus('Preparing the migration transaction');
        return;
      case 'inventory started':
      case 'inventory progress':
      case 'inventory complete':
        this.updateStatus(this.inventoryStatus(message, details));
        return;
      case 'transaction continuing':
        this.updateStatus(
          `Preparing transaction${this.namedSuffix(details, 'phase')}`,
        );
        return;
      case 'commit entry started':
        this.updateStatus([
          `Publishing ${stringDetail(details, 'position') ?? ''}`.trim(),
          stringDetail(details, 'subtree'),
        ].filter(Boolean).join(this.separator()));
        return;
      case 'commit entry published':
        this.updateStatus([
          `Published ${stringDetail(details, 'position') ?? ''}`.trim(),
          stringDetail(details, 'subtree'),
        ].filter(Boolean).join(this.separator()));
        return;
      case 'completion marker published':
        this.milestone('Workspace layout published');
        this.updateStatus('Verifying published workspace data');
        return;
      case 'cleanup started':
        this.updateStatus(`Cleanup${this.countSuffix(details, 'entries', 'locations')}`);
        return;
      case 'cleanup entry':
        this.updateStatus([
          `Cleaning up ${stringDetail(details, 'position') ?? ''}`.trim(),
          stringDetail(details, 'subtree'),
        ].filter(Boolean).join(this.separator()));
        return;
      case 'cleanup complete':
        this.milestone('Cleanup complete');
        this.updateStatus('Finalizing workspace startup');
        return;
      case 'layout already current; no data move required':
        this.milestone('Workspace layout already current');
        this.updateStatus('Finalizing workspace startup');
        return;
      case 'exclusive lock released':
        this.updateStatus('Finalizing workspace startup');
        return;
      case 'finished successfully':
        this.finishSuccess(details);
        return;
      case 'FAILED - no conflicting data was overwritten':
        this.finishFailure(details);
        return;
      default:
        this.updateStatus(safeTerminalText(message));
    }
  }

  close(): void {
    this.stopAnimation();
    this.clearLiveLine();
    this.ended = true;
  }

  private start(details: MigrationProgressDetails): void {
    this.close();
    this.ended = false;
    this.animationTick = 0;
    this.scenic = this.terminalWidth() >= 72;
    const version = stringDetail(details, 'version');
    const dataRoot = stringDetail(details, 'dataRoot');
    if (this.scenic) {
      this.writeRiversideTitle(version, dataRoot);
    } else {
      this.writeLine(
        `${style('FLUJO', ANSI.bold + ANSI.magenta, this.colors)} ${style(
          `${this.ascii ? '-' : '·'} Workspace migration${version ? ` v${version}` : ''}`,
          ANSI.dim,
          this.colors,
        )}`,
      );
      if (dataRoot) this.writeLine(style(`Data: ${dataRoot}`, ANSI.dim, this.colors));
    }
    this.liveStatus = 'Starting migration checks';
    this.startAnimation();
    this.renderLiveLine();
  }

  private startAnimation(): void {
    this.stopAnimation();
    this.animationTimer = setInterval(() => {
      this.animationTick += 1;
      this.renderLiveLine();
    }, this.animationIntervalMs);
    this.animationTimer.unref?.();
  }

  private stopAnimation(): void {
    if (!this.animationTimer) return;
    clearInterval(this.animationTimer);
    this.animationTimer = undefined;
  }

  private updateStatus(status: string): void {
    this.liveStatus = safeTerminalText(status) || 'Working';
    this.renderLiveLine();
  }

  private renderLiveLine(): void {
    if (!this.liveStatus || this.ended) return;
    this.clearLiveLine();
    const frame = this.frames[this.animationTick % this.frames.length];
    const runner = this.scenic ? this.runnerTrack(14) : '';
    const prefixWidth = runner ? 17 : 2;
    const available = Math.max(1, this.terminalWidth() - prefixWidth - 1);
    const status = this.truncate(this.liveStatus, available);
    this.stream.write(
      `${style(frame, ANSI.cyan, this.colors)} ${runner}${runner ? ' ' : ''}${status}`,
    );
    this.liveLineRendered = true;
  }

  private clearLiveLine(): void {
    if (!this.liveLineRendered) return;
    const writable = this.stream as unknown as NodeJS.WritableStream;
    clearLine(writable, 0);
    cursorTo(writable, 0);
    this.liveLineRendered = false;
  }

  private writeLine(line: string): void {
    this.clearLiveLine();
    this.stream.write(`${line}\n`);
  }

  private writeRiversideTitle(version?: string, dataRoot?: string): void {
    const canvasWidth = 60;
    const margin = ' '.repeat(Math.max(0, Math.floor((this.terminalWidth() - canvasWidth) / 2)));
    const centered = (value: string): string => {
      const content = this.truncate(value, canvasWidth);
      const left = Math.max(0, Math.floor((canvasWidth - Array.from(content).length) / 2));
      return `${' '.repeat(left)}${content}`;
    };
    const scene: Array<{ line: string; color: string }> = [
      { line: centered('F L U J O'), color: ANSI.bold + ANSI.magenta },
      { line: centered('where ideas find their flow'), color: ANSI.dim },
      { line: '', color: ANSI.reset },
      { line: '          .        /\\          /\\                   v', color: ANSI.cyan },
      { line: '      ___/ \\______/  \\________/  \\___', color: ANSI.green },
      { line: '  ^..^>                     o/--------.', color: ANSI.yellow },
      { line: '___________________________/|\\         )', color: ANSI.green },
      { line: ' ~  ~  ~  ~  ~  ~  ~  ~  / \\  <__\\o/__>  ~  ~  ~', color: ANSI.cyan },
      {
        line: centered(
          this.truncate(
            `Workspace migration${version ? ` v${version}` : ''}${dataRoot ? `${this.separator()}Data: ${dataRoot}` : ''}`,
            canvasWidth,
          ),
        ),
        color: ANSI.dim,
      },
    ];
    for (const { line, color } of scene) {
      this.writeLine(line ? `${margin}${style(line, color, this.colors)}`.trimEnd() : '');
    }
  }

  private runnerTrack(width: number): string {
    const rightFacing = '^..^>';
    const leftFacing = '<^..^';
    const distance = Math.max(0, width - rightFacing.length);
    const cycleLength = Math.max(1, distance * 2);
    const cyclePosition = this.animationTick % cycleLength;
    const movingRight = cyclePosition <= distance;
    const position = movingRight ? cyclePosition : cycleLength - cyclePosition;
    const meadow: string[] = Array.from({ length: width }, (_value, index) =>
      index % 4 === 1 ? (this.ascii ? '.' : '·') : ' ',
    );
    const runner = movingRight ? rightFacing : leftFacing;
    for (const [index, character] of Array.from(runner).entries()) {
      meadow[position + index] = character;
    }
    return meadow.join('');
  }

  private terminalWidth(): number {
    const columns = this.stream.columns;
    return typeof columns === 'number' && Number.isFinite(columns) && columns > 0
      ? Math.floor(columns)
      : 100;
  }

  private milestone(label: string, kind: 'success' | 'warning' = 'success'): void {
    const symbol = this.ascii
      ? kind === 'success' ? '[ok]' : '[!]'
      : kind === 'success' ? '✓' : '!';
    const color = kind === 'success' ? ANSI.green : ANSI.yellow;
    this.writeLine(`${style(symbol, color, this.colors)} ${safeTerminalText(label)}`);
  }

  private finishSuccess(details: MigrationProgressDetails): void {
    this.stopAnimation();
    this.clearLiveLine();
    const symbol = this.ascii ? '[ok]' : '✓';
    const elapsed = stringDetail(details, 'elapsed');
    this.writeLine(
      `${style(symbol, ANSI.green, this.colors)} ${style(
        `Workspace migration complete${elapsed ? `${this.separator()}${elapsed}` : ''}`,
        ANSI.bold,
        this.colors,
      )}`,
    );
    this.ended = true;
  }

  private finishFailure(details: MigrationProgressDetails): void {
    this.stopAnimation();
    this.clearLiveLine();
    const symbol = this.ascii ? '[x]' : '✕';
    this.writeLine(
      `${style(symbol, ANSI.red, this.colors)} ${style(
        'Workspace migration failed safely',
        ANSI.bold,
        this.colors,
      )}`,
    );
    const code = stringDetail(details, 'code');
    const error = stringDetail(details, 'error');
    if (code || error) {
      this.writeLine(style(`  ${[code, error].filter(Boolean).join(this.separator())}`, ANSI.dim, this.colors));
    }
    this.ended = true;
  }

  private inventoryStatus(message: string, details: MigrationProgressDetails): string {
    const purpose = stringDetail(details, 'purpose');
    const root = stringDetail(details, 'root');
    let label: string;
    if (purpose?.startsWith('preflight source for ')) {
      label = `Scanning legacy ${purpose.slice('preflight source for '.length)}`;
    } else if (purpose?.startsWith('preflight destination for ')) {
      label = `Checking workspace ${purpose.slice('preflight destination for '.length)}`;
    } else if (purpose && purpose !== 'inventory') {
      label = purpose;
    } else {
      label = `Verifying ${root ? path.basename(root) || 'data' : 'data'}`;
    }
    if (message === 'inventory complete') label = label.replace(/^(Scanning|Checking|Verifying)/, 'Verified');

    const counters = [
      this.metric(details, 'files', 'files'),
      this.metric(details, 'directories', 'dirs'),
      this.metric(details, 'links', 'links'),
      stringDetail(details, 'bytes'),
      stringDetail(details, 'elapsed'),
    ].filter(Boolean);
    return [label, ...counters].join(this.separator());
  }

  private metric(details: MigrationProgressDetails, key: string, label: string): string | undefined {
    const value = stringDetail(details, key);
    return value === undefined ? undefined : `${value} ${label}`;
  }

  private namedSuffix(details: MigrationProgressDetails, key: string): string {
    const value = stringDetail(details, key);
    return value ? `${this.separator()}${value}` : '';
  }

  private countSuffix(details: MigrationProgressDetails, key: string, label: string): string {
    const value = stringDetail(details, key);
    return value ? `${this.separator()}${value} ${label}` : '';
  }

  private position(details: MigrationProgressDetails, currentKey: string, totalKey: string): string {
    const current = stringDetail(details, currentKey);
    const total = stringDetail(details, totalKey);
    return current && total ? `${this.separator()}${current}/${total}` : '';
  }

  private separator(): string {
    return this.ascii ? ' - ' : ' · ';
  }

  private truncate(value: string, maximum: number): string {
    const characters = Array.from(value);
    if (characters.length <= maximum) return value;
    const suffix = this.ascii ? '...' : '…';
    if (maximum <= suffix.length) return suffix.slice(0, maximum);
    return `${characters.slice(0, maximum - suffix.length).join('')}${suffix}`;
  }
}

export function shouldUseInteractiveMigrationUI(
  stream: MigrationTerminalStream = process.stdout,
  env: MigrationEnvironment = process.env,
): boolean {
  const requested = env.FLUJO_MIGRATION_UI?.trim().toLowerCase();
  if (requested === 'plain') return false;
  if (requested === 'tty') return true;
  const ci = env.CI?.trim().toLowerCase();
  const isCi = Boolean(ci && ci !== '0' && ci !== 'false');
  return Boolean(stream.isTTY) && env.TERM !== 'dumb' && !isCi;
}

function terminalSupportsColor(
  stream: MigrationTerminalStream,
  env: MigrationEnvironment,
): boolean {
  if ('NO_COLOR' in env || 'NODE_DISABLE_COLORS' in env || env.FORCE_COLOR === '0') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return stream.hasColors?.(16) ?? Boolean(stream.isTTY);
}

export function createMigrationProgressReporter(
  options: MigrationProgressReporterOptions,
): MigrationProgressReporter {
  if (!options.interactive) {
    return new PlainMigrationProgressReporter(
      options.info ?? (line => console.info(line)),
      options.error ?? (line => console.error(line)),
    );
  }
  const stream = options.stream ?? process.stdout;
  return new TtyMigrationProgressReporter(
    stream,
    options.colors ?? terminalSupportsColor(stream, process.env),
    options.ascii ?? false,
    options.animationIntervalMs ?? 80,
  );
}

let activeReporter: MigrationProgressReporter | undefined;

function createDefaultReporter(): MigrationProgressReporter {
  const stream = process.stdout;
  return createMigrationProgressReporter({
    interactive: shouldUseInteractiveMigrationUI(stream),
    stream,
    colors: terminalSupportsColor(stream, process.env),
    ascii: ['1', 'true', 'yes'].includes(
      process.env.FLUJO_MIGRATION_ASCII?.trim().toLowerCase() ?? '',
    ),
  });
}

export function reportWorkspaceMigration(
  message: string,
  details: MigrationProgressDetails = {},
  level: MigrationProgressLevel = 'info',
): void {
  // Runtime migrations stay visible regardless of the configured application
  // log level. Jest remains quiet unless a migration test opts into the real
  // transcript explicitly.
  if (process.env.NODE_ENV === 'test' && process.env.FLUJO_MIGRATION_VERBOSE !== '1') return;

  if (message === 'started') {
    activeReporter?.close();
    activeReporter = createDefaultReporter();
  }
  activeReporter ??= createDefaultReporter();
  activeReporter.report(message, details, level);
  if (TERMINAL_EVENT_NAMES.has(message)) activeReporter = undefined;
}

export function resetWorkspaceMigrationProgress(): void {
  activeReporter?.close();
  activeReporter = undefined;
}
