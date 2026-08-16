import path from 'node:path';
import { clearLine, cursorTo } from 'node:readline';
import {
  MigrationLandscapeSession,
  terminalCanShowMigrationLandscape,
} from './migrationLandscape';

export type MigrationProgressDetails = Record<
  string,
  string | number | boolean | undefined
>;

export type MigrationProgressLevel = 'info' | 'error';

interface MigrationTerminalStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  hasColors?: (count?: number) => boolean;
  once?(event: 'drain', listener: () => void): unknown;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

interface MigrationTerminalInput {
  isTTY?: boolean;
  isRaw?: boolean;
  isPaused?(): boolean;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on?(event: 'data', listener: (chunk: unknown) => void): unknown;
  off?(event: 'data', listener: (chunk: unknown) => void): unknown;
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
  fullscreen?: boolean;
  trueColor?: boolean;
  animationIntervalMs?: number;
  input?: MigrationTerminalInput;
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
    .filter((entry): entry is [string, string | number | boolean] =>
      entry[1] !== undefined && !entry[0].startsWith('_'),
    )
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

interface ActivitySample {
  key: string;
  at: number;
  bytes: number;
  files: number;
  bytesPerSecond: number;
  filesPerSecond: number;
  complete: boolean;
}

class LandscapeMigrationProgressReporter implements MigrationProgressReporter {
  private readonly landscape: MigrationLandscapeSession;
  private readonly fallbackReporter: PlainMigrationProgressReporter;
  private progress = 0.02;
  private bytesPerSecond = 0;
  private filesPerSecond = 0;
  private activityLabel = 'Preparing';
  private readonly samples = new Map<string, ActivitySample>();
  private ended = false;
  private dismissed = false;
  private inputAttached = false;
  private inputWasPaused = false;
  private inputWasRaw = false;
  private lastMessage = 'started';
  private lastDetails: MigrationProgressDetails = {};
  private lastLevel: MigrationProgressLevel = 'info';

  constructor(
    private readonly stream: MigrationTerminalStream,
    private readonly colors: boolean,
    trueColor: boolean,
    private readonly input: MigrationTerminalInput = process.stdin,
  ) {
    this.landscape = new MigrationLandscapeSession({ stream, trueColor });
    this.fallbackReporter = new PlainMigrationProgressReporter(
      line => { this.stream.write(`${line}\n`); },
      line => { this.stream.write(`${line}\n`); },
    );
  }

  report(
    message: string,
    details: MigrationProgressDetails = {},
    _level: MigrationProgressLevel = 'info',
  ): void {
    if (this.ended && message !== 'started') return;

    this.lastMessage = message;
    this.lastDetails = details;
    this.lastLevel = _level;

    if (this.dismissed) {
      this.fallbackReporter.report(message, details, _level);
      if (TERMINAL_EVENT_NAMES.has(message)) this.ended = true;
      return;
    }

    if (message === 'started') {
      this.ended = false;
      this.progress = 0.02;
      const version = stringDetail(details, 'version');
      const dataRoot = stringDetail(details, 'dataRoot');
      this.landscape.start({
        phase: 'Starting migration checks',
        detail: [version ? `Layout v${version}` : undefined, dataRoot].filter(Boolean).join(' · ')
          || 'Preparing a safe workspace upgrade',
        progress: this.progress,
      });
      this.attachInput();
      return;
    }

    if (!message.startsWith('inventory ') && !message.startsWith('transfer ')) {
      this.bytesPerSecond = 0;
      this.filesPerSecond = 0;
      this.activityLabel = 'Preparing';
    }

    switch (message) {
      case 'exclusive lock acquired':
        this.update('Checking existing workspace state', 'Exclusive migration lock acquired', 0.06);
        return;
      case 'reclaiming stale migration lock':
        this.update('Recovering workspace state', 'Reclaiming an interrupted migration lock', 0.07);
        return;
      case 'recovering durable transaction':
        this.update(
          'Recovering an interrupted migration',
          `Validating durable transaction${this.namedDetail(details, 'phase')}`,
          0.09,
        );
        return;
      case 'existing layout marker found':
        this.update('Validating the existing workspace layout', 'Checking the published layout marker', 0.08);
        return;
      case 'reconciliation pass':
        this.update(
          'Checking migration state',
          `Reconciliation${this.positionDetail(details, 'pass', 'maximum')}`,
          0.08 + this.ratio(details, 'pass', 'maximum') * 0.02,
        );
        return;
      case 'preflight started':
        this.update(
          'Planning a safe migration',
          `Preflight${this.countDetail(details, 'candidates', 'locations')}`,
          0.10,
        );
        return;
      case 'preflight candidate': {
        const ratio = this.positionRatio(details);
        this.update(
          `Inspecting ${stringDetail(details, 'subtree') ?? 'workspace data'}`,
          `Preflight${this.positionFromDetails(details)}`,
          0.12 + ratio * 0.22,
        );
        return;
      }
      case 'preflight candidate ready': {
        const ratio = this.positionRatio(details);
        this.update(
          `Ready: ${stringDetail(details, 'subtree') ?? 'workspace data'}`,
          [stringDetail(details, 'position'), stringDetail(details, 'outcome')].filter(Boolean).join(' · '),
          0.14 + ratio * 0.22,
        );
        return;
      }
      case 'preflight complete':
        this.update(
          'Preparing the migration transaction',
          `Preflight complete${this.countDetail(details, 'entries', 'locations')}`,
          0.38,
        );
        return;
      case 'inventory started':
      case 'inventory progress':
      case 'inventory complete':
        this.updateActivity(message, details, 'inventory');
        this.update(
          this.inventoryPhase(message, details),
          this.inventoryDetail(details),
        );
        return;
      case 'transfer started':
      case 'transfer progress':
      case 'transfer complete':
        this.updateActivity(message, details, 'transfer');
        this.update(
          message === 'transfer complete'
            ? `Staged ${stringDetail(details, 'subtree') ?? 'workspace data'}`
            : `Copying ${stringDetail(details, 'subtree') ?? 'workspace data'}`,
          this.transferDetail(details),
          message === 'transfer complete' ? 0.48 : 0.42,
        );
        return;
      case 'transaction continuing':
        this.update(
          'Preparing the durable transaction',
          [stringDetail(details, 'phase'), stringDetail(details, 'strategy')].filter(Boolean).join(' · '),
          0.42,
        );
        return;
      case 'commit entry started': {
        const ratio = this.positionRatio(details);
        this.update(
          `Publishing ${stringDetail(details, 'subtree') ?? 'workspace data'}`,
          [stringDetail(details, 'position'), stringDetail(details, 'strategy')].filter(Boolean).join(' · '),
          0.48 + ratio * 0.30,
        );
        return;
      }
      case 'commit entry published': {
        const ratio = this.positionRatio(details);
        this.update(
          `Published ${stringDetail(details, 'subtree') ?? 'workspace data'}`,
          stringDetail(details, 'position') ?? 'Atomic publish complete',
          0.50 + ratio * 0.30,
        );
        return;
      }
      case 'completion marker published':
        this.update('Verifying published workspace data', 'Workspace layout marker published', 0.82);
        return;
      case 'cleanup started':
        this.update(
          'Cleaning up the completed transaction',
          `Original data remains protected${this.countDetail(details, 'entries', 'locations')}`,
          0.84,
        );
        return;
      case 'cleanup entry': {
        const ratio = this.positionRatio(details);
        this.update(
          `Cleaning up ${stringDetail(details, 'subtree') ?? 'workspace data'}`,
          stringDetail(details, 'position') ?? 'Removing verified transaction artifacts',
          0.84 + ratio * 0.13,
        );
        return;
      }
      case 'cleanup complete':
        this.update('Finalizing workspace startup', 'Cleanup complete', 0.98);
        return;
      case 'layout already current; no data move required':
        this.update('Workspace layout already current', 'No data move was required', 0.98);
        return;
      case 'exclusive lock released':
        this.update('Finalizing workspace startup', 'Migration lock released', 0.99);
        return;
      case 'finished successfully':
        this.finishSuccess(details);
        return;
      case 'FAILED - no conflicting data was overwritten':
        this.finishFailure(details);
        return;
      default:
        this.update(safeTerminalText(message), this.summaryDetails(details));
    }
  }

  close(): void {
    this.detachInput();
    this.landscape.close();
    this.ended = true;
  }

  private readonly handleInput = (chunk: unknown): void => {
    const key = String(chunk);
    if (key === 'q' || key === 'Q' || key === '\u001B') {
      this.dismissToLogs();
      return;
    }
    // Raw mode turns Ctrl+C into input instead of SIGINT. Restore the terminal
    // before forwarding it so the server's normal shutdown handlers still run.
    if (key.includes('\u0003')) {
      this.detachInput();
      this.landscape.close();
      process.kill(process.pid, 'SIGINT');
    }
  };

  private attachInput(): void {
    if (this.inputAttached || !this.input.isTTY || !this.input.setRawMode || !this.input.on) return;
    this.inputWasPaused = this.input.isPaused?.() ?? false;
    this.inputWasRaw = Boolean(this.input.isRaw);
    try {
      if (!this.inputWasRaw) this.input.setRawMode(true);
      this.input.on('data', this.handleInput);
      this.input.resume?.();
      this.inputAttached = true;
    } catch {
      // The landscape remains usable when stdin is detached or cannot enter raw mode.
      if (!this.inputWasRaw) {
        try { this.input.setRawMode(false); } catch { /* Best effort. */ }
      }
    }
  }

  private detachInput(): void {
    if (!this.inputAttached) return;
    this.input.off?.('data', this.handleInput);
    if (!this.inputWasRaw && this.input.setRawMode) {
      try { this.input.setRawMode(false); } catch { /* Terminal may already be detached. */ }
    }
    if (this.inputWasPaused) this.input.pause?.();
    this.inputAttached = false;
  }

  private dismissToLogs(): void {
    if (this.dismissed || this.ended) return;
    this.dismissed = true;
    this.detachInput();
    this.landscape.close();
    this.fallbackReporter.report('landscape closed; continuing with log output');
    this.fallbackReporter.report(this.lastMessage, this.lastDetails, this.lastLevel);
  }

  private update(phase: string, detail = '', progress?: number): void {
    if (progress !== undefined) this.progress = Math.max(this.progress, progress);
    this.landscape.update({
      phase: safeTerminalText(phase),
      detail: safeTerminalText(detail) || 'Working carefully through workspace data',
      progress: this.progress,
      bytesPerSecond: this.bytesPerSecond,
      filesPerSecond: this.filesPerSecond,
      activityLabel: this.activityLabel,
    });
  }

  private updateActivity(
    message: string,
    details: MigrationProgressDetails,
    kind: 'inventory' | 'transfer',
  ): void {
    const key = `${kind}:${stringDetail(details, 'purpose') ?? ''}:${stringDetail(details, 'root') ?? ''}:${stringDetail(details, 'subtree') ?? ''}`;
    const bytes = this.numericDetail(details, '_bytes');
    const files = this.numericDetail(details, 'files');
    const now = Date.now();
    const starting = message.endsWith('started');
    const previous = this.samples.get(key);
    if (starting || !previous || bytes < previous.bytes || files < previous.files) {
      this.samples.set(key, {
        key,
        at: now,
        bytes,
        files,
        bytesPerSecond: 0,
        filesPerSecond: 0,
        complete: false,
      });
    } else {
      const elapsedSeconds = (now - previous.at) / 1000;
      if (elapsedSeconds > 0) {
        const nextBytesPerSecond = Math.max(0, bytes - previous.bytes) / elapsedSeconds;
        const nextFilesPerSecond = Math.max(0, files - previous.files) / elapsedSeconds;
        const weight = previous.bytesPerSecond > 0 || previous.filesPerSecond > 0 ? 0.45 : 1;
        this.samples.set(key, {
          key,
          at: now,
          bytes,
          files,
          bytesPerSecond: previous.bytesPerSecond
            + (nextBytesPerSecond - previous.bytesPerSecond) * weight,
          filesPerSecond: previous.filesPerSecond
            + (nextFilesPerSecond - previous.filesPerSecond) * weight,
          complete: message.endsWith('complete'),
        });
      }
    }
    const current = this.samples.get(key);
    const recentSamples = [...this.samples.values()].filter(sample =>
      now - sample.at <= 15_000 && (!sample.complete || sample.key === key),
    );
    this.bytesPerSecond = recentSamples.reduce((total, sample) => total + sample.bytesPerSecond, 0);
    this.filesPerSecond = recentSamples.reduce((total, sample) => total + sample.filesPerSecond, 0);
    if (message.endsWith('complete') && current) current.complete = true;
    for (const sample of this.samples.values()) {
      if (now - sample.at > 15_000) this.samples.delete(sample.key);
    }
    this.activityLabel = kind === 'transfer'
      ? 'Copying'
      : stringDetail(details, 'content') === 'sha256' ? 'Reading' : 'Indexing';
  }

  private inventoryPhase(message: string, details: MigrationProgressDetails): string {
    const purpose = stringDetail(details, 'purpose');
    let label: string;
    if (purpose?.startsWith('preflight source for ')) {
      label = `Scanning legacy ${purpose.slice('preflight source for '.length)}`;
    } else if (purpose?.startsWith('preflight destination for ')) {
      label = `Checking workspace ${purpose.slice('preflight destination for '.length)}`;
    } else if (purpose && purpose !== 'inventory') {
      label = purpose;
    } else {
      const root = stringDetail(details, 'root');
      label = `Verifying ${root ? path.basename(root) || 'data' : 'data'}`;
    }
    if (message === 'inventory complete') label = label.replace(/^(Scanning|Checking|Verifying)/, 'Verified');
    return label;
  }

  private inventoryDetail(details: MigrationProgressDetails): string {
    return [
      this.metric(details, 'files', 'files'),
      this.metric(details, 'directories', 'dirs'),
      this.metric(details, 'links', 'links'),
      stringDetail(details, 'bytes'),
      stringDetail(details, 'elapsed'),
    ].filter(Boolean).join(' · ');
  }

  private transferDetail(details: MigrationProgressDetails): string {
    const files = this.metric(details, 'files', 'files');
    const totalFiles = stringDetail(details, 'totalFiles');
    const bytes = stringDetail(details, 'bytes');
    const totalBytes = stringDetail(details, 'totalBytes');
    return [
      files && totalFiles ? `${files} of ${totalFiles}` : files,
      bytes && totalBytes ? `${bytes} of ${totalBytes}` : bytes,
      stringDetail(details, 'elapsed'),
    ].filter(Boolean).join(' · ');
  }

  private finishSuccess(details: MigrationProgressDetails): void {
    this.update(
      'Workspace migration complete',
      'Everything is right where it should be',
      1,
    );
    this.detachInput();
    this.landscape.close();
    const elapsed = stringDetail(details, 'elapsed');
    this.stream.write(`${style('✓', ANSI.green, this.colors)} ${style(
      `Workspace migration complete${elapsed ? ` · ${elapsed}` : ''}`,
      ANSI.bold,
      this.colors,
    )}\n`);
    this.ended = true;
  }

  private finishFailure(details: MigrationProgressDetails): void {
    this.detachInput();
    this.landscape.close();
    this.stream.write(`${style('✕', ANSI.red, this.colors)} ${style(
      'Workspace migration failed safely; no conflicting data was overwritten',
      ANSI.bold,
      this.colors,
    )}\n`);
    const error = [stringDetail(details, 'code'), stringDetail(details, 'error')].filter(Boolean).join(' · ');
    if (error) this.stream.write(`${style(`  ${error}`, ANSI.dim, this.colors)}\n`);
    this.ended = true;
  }

  private metric(details: MigrationProgressDetails, key: string, label: string): string | undefined {
    const value = stringDetail(details, key);
    return value === undefined ? undefined : `${value} ${label}`;
  }

  private numericDetail(details: MigrationProgressDetails, key: string): number {
    const value = details[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  private namedDetail(details: MigrationProgressDetails, key: string): string {
    const value = stringDetail(details, key);
    return value ? ` · ${value}` : '';
  }

  private countDetail(details: MigrationProgressDetails, key: string, label: string): string {
    const value = stringDetail(details, key);
    return value ? ` · ${value} ${label}` : '';
  }

  private positionDetail(details: MigrationProgressDetails, currentKey: string, totalKey: string): string {
    const current = stringDetail(details, currentKey);
    const total = stringDetail(details, totalKey);
    return current && total ? ` · ${current}/${total}` : '';
  }

  private positionFromDetails(details: MigrationProgressDetails): string {
    const position = stringDetail(details, 'position');
    return position ? ` · ${position}` : '';
  }

  private positionRatio(details: MigrationProgressDetails): number {
    const position = stringDetail(details, 'position');
    const match = position?.match(/^(\d+)\/(\d+)$/);
    if (!match) return 0;
    const current = Number(match[1]);
    const total = Number(match[2]);
    return total > 0 ? Math.min(1, current / total) : 0;
  }

  private ratio(details: MigrationProgressDetails, currentKey: string, totalKey: string): number {
    const current = this.numericDetail(details, currentKey);
    const total = this.numericDetail(details, totalKey);
    return total > 0 ? Math.min(1, current / total) : 0;
  }

  private summaryDetails(details: MigrationProgressDetails): string {
    return Object.entries(details)
      .filter(([key, value]) => !key.startsWith('_') && value !== undefined)
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${safeTerminalText(value)}`)
      .join(' · ');
  }
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
  if (requested === 'tty' || requested === 'compact' || requested === 'landscape') return true;
  const ci = env.CI?.trim().toLowerCase();
  const isCi = Boolean(ci && ci !== '0' && ci !== 'false');
  return Boolean(stream.isTTY) && env.TERM !== 'dumb' && !isCi;
}

export function shouldUseFullscreenMigrationUI(
  stream: MigrationTerminalStream = process.stdout,
  env: MigrationEnvironment = process.env,
): boolean {
  const requested = env.FLUJO_MIGRATION_UI?.trim().toLowerCase();
  if (requested === 'plain' || requested === 'tty' || requested === 'compact') return false;
  if (!shouldUseInteractiveMigrationUI(stream, env)) return false;
  if (!terminalSupportsColor(stream, env)) return false;
  if (['1', 'true', 'yes'].includes(env.FLUJO_MIGRATION_ASCII?.trim().toLowerCase() ?? '')) return false;
  return terminalCanShowMigrationLandscape(stream);
}

function terminalSupportsColor(
  stream: MigrationTerminalStream,
  env: MigrationEnvironment,
): boolean {
  if ('NO_COLOR' in env || 'NODE_DISABLE_COLORS' in env || env.FORCE_COLOR === '0') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return stream.hasColors?.(16) ?? Boolean(stream.isTTY);
}

function terminalSupportsTrueColor(
  stream: MigrationTerminalStream,
  env: MigrationEnvironment,
): boolean {
  if (env.COLORTERM?.toLowerCase().includes('truecolor')) return true;
  return stream.hasColors?.(16_777_216) ?? false;
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
  const colors = options.colors ?? terminalSupportsColor(stream, process.env);
  if (options.fullscreen && colors && terminalCanShowMigrationLandscape(stream)) {
    return new LandscapeMigrationProgressReporter(
      stream,
      colors,
      options.trueColor ?? terminalSupportsTrueColor(stream, process.env),
      options.input ?? process.stdin,
    );
  }
  return new TtyMigrationProgressReporter(
    stream,
    colors,
    options.ascii ?? false,
    options.animationIntervalMs ?? 80,
  );
}

let activeReporter: MigrationProgressReporter | undefined;

function createDefaultReporter(): MigrationProgressReporter {
  const stream = process.stdout;
  const colors = terminalSupportsColor(stream, process.env);
  return createMigrationProgressReporter({
    interactive: shouldUseInteractiveMigrationUI(stream),
    stream,
    colors,
    fullscreen: shouldUseFullscreenMigrationUI(stream),
    trueColor: terminalSupportsTrueColor(stream, process.env),
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
