import { performance } from 'node:perf_hooks';

type Color = readonly [number, number, number];

export type MigrationLandscapeTheme = 'daybreak' | 'twilight' | 'moonlight';

export interface MigrationLandscapeState {
  phase: string;
  detail: string;
  progress: number;
  bytesPerSecond: number;
  filesPerSecond: number;
  activityLabel?: string;
}

export interface MigrationLandscapeStream {
  write(chunk: string): unknown;
  columns?: number;
  rows?: number;
  once?(event: 'drain', listener: () => void): unknown;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

export interface MigrationLandscapeOptions {
  stream: MigrationLandscapeStream;
  theme?: MigrationLandscapeTheme;
  trueColor?: boolean;
  framesPerSecond?: number;
}

export interface MigrationLandscapeMotion {
  riverSpeed: number;
  actorSpeed: number;
  panningSpeed: number;
  mountainHeightScale: number;
}

interface Palette {
  name: string;
  skyTop: Color;
  skyBottom: Color;
  cloud: Color;
  star: Color;
  sun: Color;
  farMountain: Color;
  nearMountain: Color;
  snow: Color;
  meadow: Color;
  meadowLight: Color;
  tree: Color;
  trunk: Color;
  riverTop: Color;
  riverBottom: Color;
  waterLight: Color;
  reflection: Color;
  title: Color;
  text: Color;
  muted: Color;
  animal: Color;
  person: Color;
  boat: Color;
  hud: Color;
  hudAlt: Color;
  accent: Color;
  success: Color;
  danger: Color;
}

interface Cell {
  character: string;
  foreground: Color;
  background: Color;
  bold: boolean;
}

const ESC = '\u001B[';
const MINIMUM_WIDTH = 56;
const MINIMUM_HEIGHT = 18;

const PALETTES: Record<MigrationLandscapeTheme, Palette> = {
  twilight: {
    name: 'Twilight',
    skyTop: [7, 12, 37],
    skyBottom: [126, 76, 145],
    cloud: [206, 195, 226],
    star: [255, 226, 174],
    sun: [255, 190, 128],
    farMountain: [68, 67, 113],
    nearMountain: [31, 52, 78],
    snow: [198, 203, 221],
    meadow: [37, 89, 69],
    meadowLight: [94, 142, 86],
    tree: [24, 72, 55],
    trunk: [111, 77, 58],
    riverTop: [28, 91, 126],
    riverBottom: [7, 29, 68],
    waterLight: [87, 185, 211],
    reflection: [204, 150, 209],
    title: [238, 122, 255],
    text: [241, 244, 255],
    muted: [169, 183, 212],
    animal: [255, 209, 134],
    person: [255, 232, 202],
    boat: [184, 112, 81],
    hud: [13, 18, 43],
    hudAlt: [20, 28, 61],
    accent: [159, 124, 255],
    success: [90, 222, 171],
    danger: [255, 126, 139],
  },
  daybreak: {
    name: 'Daybreak',
    skyTop: [40, 118, 178],
    skyBottom: [255, 190, 131],
    cloud: [245, 238, 218],
    star: [255, 244, 203],
    sun: [255, 227, 137],
    farMountain: [109, 132, 139],
    nearMountain: [51, 89, 91],
    snow: [238, 240, 226],
    meadow: [47, 116, 68],
    meadowLight: [128, 174, 84],
    tree: [26, 91, 55],
    trunk: [120, 78, 48],
    riverTop: [57, 151, 183],
    riverBottom: [18, 75, 121],
    waterLight: [169, 228, 229],
    reflection: [255, 213, 143],
    title: [255, 245, 224],
    text: [250, 250, 238],
    muted: [213, 230, 224],
    animal: [242, 185, 90],
    person: [255, 229, 191],
    boat: [151, 78, 45],
    hud: [17, 47, 65],
    hudAlt: [24, 61, 77],
    accent: [255, 192, 103],
    success: [117, 239, 165],
    danger: [255, 126, 126],
  },
  moonlight: {
    name: 'Moonlight',
    skyTop: [2, 7, 24],
    skyBottom: [32, 54, 93],
    cloud: [111, 127, 157],
    star: [217, 229, 255],
    sun: [222, 232, 255],
    farMountain: [39, 51, 83],
    nearMountain: [15, 35, 52],
    snow: [156, 176, 207],
    meadow: [18, 64, 55],
    meadowLight: [52, 102, 77],
    tree: [8, 42, 38],
    trunk: [73, 63, 64],
    riverTop: [17, 65, 103],
    riverBottom: [3, 18, 52],
    waterLight: [63, 143, 184],
    reflection: [172, 195, 246],
    title: [176, 149, 255],
    text: [222, 231, 251],
    muted: [128, 147, 181],
    animal: [207, 179, 131],
    person: [214, 203, 193],
    boat: [103, 76, 72],
    hud: [6, 11, 31],
    hudAlt: [12, 22, 47],
    accent: [122, 112, 232],
    success: [70, 195, 157],
    danger: [236, 100, 125],
  },
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function mixColor(from: Color, to: Color, amount: number): Color {
  const factor = clamp(amount, 0, 1);
  return from.map((channel, index) =>
    Math.round(channel + (to[index] - channel) * factor),
  ) as unknown as Color;
}

function colorKey(color: Color): string {
  return color.join(',');
}

function rgbToAnsi256([red, green, blue]: Color): number {
  const r = Math.round((red / 255) * 5);
  const g = Math.round((green / 255) * 5);
  const b = Math.round((blue / 255) * 5);
  return 16 + 36 * r + 6 * g + b;
}

function styleSequence(
  foreground: Color,
  background: Color,
  bold: boolean,
  trueColor: boolean,
): string {
  if (!trueColor) {
    return `${ESC}0${bold ? ';1' : ''};38;5;${rgbToAnsi256(foreground)};48;5;${rgbToAnsi256(background)}m`;
  }
  return `${ESC}0${bold ? ';1' : ''};38;2;${foreground.join(';')};48;2;${background.join(';')}m`;
}

class Canvas {
  readonly cells: Cell[][];

  constructor(
    readonly width: number,
    readonly height: number,
    backgroundAt: (row: number) => Color,
    foreground: Color,
  ) {
    this.cells = Array.from({ length: height }, (_row, y) =>
      Array.from({ length: width }, () => ({
        character: ' ',
        foreground,
        background: backgroundAt(y),
        bold: false,
      })),
    );
  }

  cell(x: number, y: number): Cell | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    return this.cells[y]?.[x];
  }

  put(
    x: number,
    y: number,
    character: string,
    foreground?: Color,
    background?: Color,
    bold = false,
  ): void {
    const cell = this.cell(Math.round(x), Math.round(y));
    if (!cell) return;
    cell.character = character;
    if (foreground) cell.foreground = foreground;
    if (background) cell.background = background;
    cell.bold = bold;
  }

  setBackground(x: number, y: number, background: Color): void {
    const cell = this.cell(x, y);
    if (!cell) return;
    cell.character = ' ';
    cell.foreground = background;
    cell.background = background;
    cell.bold = false;
  }

  fillBackground(x: number, y: number, width: number, height: number, background: Color): void {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row += 1) {
      for (let column = Math.max(0, x); column < Math.min(this.width, x + width); column += 1) {
        this.setBackground(column, row, background);
      }
    }
  }

  text(
    x: number,
    y: number,
    value: string,
    foreground: Color,
    background?: Color,
    bold = false,
    transparentSpaces = false,
  ): void {
    for (const [offset, character] of Array.from(value).entries()) {
      if (transparentSpaces && character === ' ') continue;
      this.put(x + offset, y, character, foreground, background, bold);
    }
  }

  centeredText(y: number, value: string, foreground: Color, bold = false): void {
    this.text(Math.floor((this.width - Array.from(value).length) / 2), y, value, foreground, undefined, bold);
  }
}

function hash(index: number): number {
  let value = (index + 1) * 2_654_435_761;
  value ^= value >>> 16;
  value = Math.imul(value, 2_246_822_519);
  value ^= value >>> 13;
  return (value >>> 0) / 0xFFFFFFFF;
}

function mountainHeight(x: number, offset: number, period: number, amplitude: number): number {
  const phase = modulo(x + offset, period) / period;
  const triangle = 1 - Math.abs(phase * 2 - 1);
  return 1 + triangle * amplitude + Math.sin((x + offset) * 0.13) * 0.8;
}

function meadowSurfaceAt(x: number, riverTop: number, time: number): number {
  return riverTop - 2 - Math.round(Math.sin((x + time * 0.7) * 0.09) * 0.7);
}

function truncateText(value: string, maximum: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  if (maximum <= 1) return '…'.slice(0, maximum);
  return `${characters.slice(0, maximum - 1).join('')}…`;
}

function formatRate(bytesPerSecond: number, filesPerSecond: number): string {
  const fields: string[] = [];
  if (bytesPerSecond > 0) {
    const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
    let value = bytesPerSecond;
    let unit = units[0];
    for (let index = 1; index < units.length && value >= 1024; index += 1) {
      value /= 1024;
      unit = units[index];
    }
    fields.push(`${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`);
  }
  if (filesPerSecond > 0) fields.push(`${filesPerSecond.toFixed(filesPerSecond >= 10 ? 0 : 1)} files/s`);
  return fields.join('  ·  ');
}

/** Select a scene from the machine's local wall-clock hour. */
export function migrationLandscapeThemeForLocalHour(hour: number): MigrationLandscapeTheme {
  const normalized = modulo(Math.floor(hour), 24);
  if (normalized >= 5 && normalized < 17) return 'daybreak';
  if (normalized >= 17 && normalized < 21) return 'twilight';
  return 'moonlight';
}

/** Convert measured activity into bounded, intentionally gentle scene motion. */
export function migrationLandscapeMotion(
  state: Pick<MigrationLandscapeState, 'bytesPerSecond' | 'filesPerSecond' | 'progress'>,
): MigrationLandscapeMotion {
  const byteActivity = clamp(Math.log10(1 + Math.max(0, state.bytesPerSecond)) / 8.4, 0, 1);
  const fileActivity = clamp(Math.log10(1 + Math.max(0, state.filesPerSecond)) / 4, 0, 1);
  const combinedActivity = Math.max(byteActivity, fileActivity);
  return {
    riverSpeed: 0.45 + byteActivity * 2.55,
    actorSpeed: 0.55 + combinedActivity * 2.45,
    panningSpeed: 0.18 + fileActivity * 0.82,
    mountainHeightScale: 0.88 + clamp(state.progress, 0, 1) * 0.20,
  };
}

export function terminalCanShowMigrationLandscape(stream: MigrationLandscapeStream): boolean {
  return (stream.columns ?? 0) >= MINIMUM_WIDTH && (stream.rows ?? 0) >= MINIMUM_HEIGHT;
}

export class MigrationLandscapeSession {
  private state: MigrationLandscapeState = {
    phase: 'Starting migration checks',
    detail: 'Preparing a safe workspace upgrade',
    progress: 0.02,
    bytesPerSecond: 0,
    filesPerSecond: 0,
  };
  private readonly palette: Palette;
  private readonly trueColor: boolean;
  private readonly intervalMs: number;
  private animationTimer?: ReturnType<typeof setInterval>;
  private lastFrameAt = performance.now();
  private skyTime = 0;
  private terrainTime = 0;
  private riverTime = 0;
  private actorTime = 0;
  private visualBytesPerSecond = 0;
  private visualFilesPerSecond = 0;
  private visualProgress = 0.02;
  private frameNumber = 0;
  private needsClear = true;
  private canWrite = true;
  private started = false;
  private closed = false;

  constructor(private readonly options: MigrationLandscapeOptions) {
    const theme = options.theme ?? migrationLandscapeThemeForLocalHour(new Date().getHours());
    this.palette = PALETTES[theme];
    this.trueColor = options.trueColor ?? true;
    this.intervalMs = 1000 / clamp(options.framesPerSecond ?? 10, 2, 30);
  }

  start(state?: Partial<MigrationLandscapeState>): void {
    if (this.started || this.closed) return;
    if (state) this.update(state);
    this.started = true;
    this.options.stream.on?.('resize', this.handleResize);
    process.once('exit', this.handleProcessExit);
    this.options.stream.write(`${ESC}?1049h${ESC}?25l${ESC}?7l${ESC}2J${ESC}H`);
    this.render();
    this.animationTimer = setInterval(() => this.render(), this.intervalMs);
    this.animationTimer.unref?.();
  }

  update(state: Partial<MigrationLandscapeState>): void {
    if (this.closed) return;
    this.state = {
      ...this.state,
      ...state,
      progress: clamp(state.progress ?? this.state.progress, 0, 1),
      bytesPerSecond: Math.max(0, state.bytesPerSecond ?? this.state.bytesPerSecond),
      filesPerSecond: Math.max(0, state.filesPerSecond ?? this.state.filesPerSecond),
    };
    if (this.started) this.render();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.animationTimer) clearInterval(this.animationTimer);
    this.animationTimer = undefined;
    this.options.stream.off?.('resize', this.handleResize);
    process.off('exit', this.handleProcessExit);
    if (!this.started) return;
    try {
      this.options.stream.write(`${ESC}0m${ESC}?7h${ESC}?1049l${ESC}?25h`);
    } catch {
      // Best effort if the terminal disappears during process shutdown.
    }
  }

  private readonly handleResize = (): void => {
    this.needsClear = true;
    this.render();
  };

  private readonly handleProcessExit = (): void => {
    this.close();
  };

  private render(now = performance.now()): void {
    if (!this.started || this.closed || !this.canWrite) return;
    const delta = clamp((now - this.lastFrameAt) / 1000, 0, 0.25);
    this.lastFrameAt = now;
    const activityBlend = 1 - Math.exp(-delta * 2.2);
    const milestoneBlend = 1 - Math.exp(-delta * 0.65);
    this.visualBytesPerSecond += (this.state.bytesPerSecond - this.visualBytesPerSecond) * activityBlend;
    this.visualFilesPerSecond += (this.state.filesPerSecond - this.visualFilesPerSecond) * activityBlend;
    this.visualProgress += (this.state.progress - this.visualProgress) * milestoneBlend;
    const motion = migrationLandscapeMotion({
      bytesPerSecond: this.visualBytesPerSecond,
      filesPerSecond: this.visualFilesPerSecond,
      progress: this.visualProgress,
    });
    this.skyTime += delta * 0.35;
    this.terrainTime += delta * motion.panningSpeed;
    this.riverTime += delta * motion.riverSpeed;
    this.actorTime += delta * motion.actorSpeed;
    this.frameNumber += 1;
    const writable = this.options.stream.write(this.renderCanvas(this.buildFrame(motion)));
    if (writable === false) {
      this.canWrite = false;
      this.options.stream.once?.('drain', () => {
        this.canWrite = true;
        this.needsClear = true;
      });
    }
  }

  private buildFrame(motion: MigrationLandscapeMotion): Canvas {
    // Leave the final physical column untouched because some terminal hosts
    // wrap after painting it even with auto-wrap disabled.
    const width = Math.max(24, (this.options.stream.columns ?? 100) - 1);
    const height = Math.max(10, this.options.stream.rows ?? 30);
    const skyHeight = Math.max(6, Math.floor(height * 0.58));
    const canvas = new Canvas(
      width,
      height,
      row => mixColor(this.palette.skyTop, this.palette.skyBottom, row / Math.max(1, skyHeight - 1)),
      this.palette.text,
    );

    if (width < MINIMUM_WIDTH || height < MINIMUM_HEIGHT) {
      this.drawCompact(canvas);
      return canvas;
    }

    const hudHeight = 4;
    const hudTop = height - hudHeight;
    const riverTop = clamp(Math.floor(height * 0.64), 11, hudTop - 2);
    const mountainBase = riverTop;

    this.drawStars(canvas, Math.max(5, riverTop - 5));
    this.drawSunOrMoon(canvas, Math.max(7, riverTop - 4));
    this.drawWrappedCloud(canvas, modulo(width * 0.14 - this.skyTime * 0.62, width + 24) - 12, 4);
    this.drawWrappedCloud(canvas, modulo(width * 0.61 - this.skyTime * 0.37, width + 24) - 12, 6);
    this.paintMountainLayer(canvas, {
      base: mountainBase,
      amplitude: Math.max(4, height * 0.22) * motion.mountainHeightScale,
      period: Math.max(24, width * 0.31),
      offset: this.terrainTime * 0.30,
      color: this.palette.farMountain,
      snow: this.palette.snow,
    });
    this.paintMountainLayer(canvas, {
      base: mountainBase,
      amplitude: Math.max(3, height * 0.15) * motion.mountainHeightScale,
      period: Math.max(18, width * 0.22),
      offset: this.terrainTime * 0.68 + 9,
      color: this.palette.nearMountain,
      snow: this.palette.nearMountain,
      snowLine: 2,
    });
    this.paintRiver(canvas, riverTop, hudTop);
    this.paintMeadow(canvas, riverTop);
    this.drawRiverDetails(canvas, riverTop, hudTop);
    this.drawWrappedTrees(canvas, riverTop);
    this.drawBirds(canvas, riverTop - 4);
    this.drawRunner(canvas, riverTop);
    this.drawFisher(canvas, riverTop);
    this.drawBoat(canvas, riverTop, hudTop);
    this.drawMessageBox(canvas, hudTop);
    canvas.centeredText(1, 'F L U J O', this.palette.title, true);
    if (height >= 22) canvas.centeredText(2, 'where ideas find their flow', this.palette.text);
    this.drawHud(canvas, hudTop);
    return canvas;
  }

  private drawStars(canvas: Canvas, skyHeight: number): void {
    const count = Math.max(16, Math.floor(canvas.width / 4));
    for (let index = 0; index < count; index += 1) {
      const x = Math.floor(modulo(hash(index) * canvas.width - this.skyTime * 0.05, canvas.width));
      const y = 2 + Math.floor(hash(index + 101) * Math.max(1, skyHeight - 5));
      const shimmer = Math.sin(this.skyTime * 1.4 + index * 2.1) > 0.72;
      canvas.put(x, y, shimmer ? '✦' : '·', this.palette.star, undefined, shimmer);
    }
  }

  private drawWrappedCloud(canvas: Canvas, origin: number, y: number): void {
    const rows = ['       .--.      ', '   .--(    ).    ', '  (__________)   '];
    const span = canvas.width + 24;
    for (const shift of [-span, 0, span]) {
      for (const [row, value] of rows.entries()) {
        canvas.text(Math.round(origin + shift), y + row, value, this.palette.cloud, undefined, false, true);
      }
    }
  }

  private paintMountainLayer(
    canvas: Canvas,
    options: {
      base: number;
      amplitude: number;
      period: number;
      offset: number;
      color: Color;
      snow: Color;
      snowLine?: number;
    },
  ): void {
    const { base, amplitude, period, offset, color, snow, snowLine = 0.74 } = options;
    for (let x = 0; x < canvas.width; x += 1) {
      const height = mountainHeight(x, offset, period, amplitude);
      const surface = clamp(Math.round(base - height), 2, base - 1);
      const boundary = height >= amplitude * snowLine ? snow : color;
      canvas.put(x, surface, '▄', boundary, canvas.cell(x, surface)?.background);
      for (let y = surface + 1; y < base; y += 1) canvas.setBackground(x, y, color);
    }
  }

  private paintMeadow(canvas: Canvas, riverTop: number): void {
    for (let x = 0; x < canvas.width; x += 1) {
      const surface = meadowSurfaceAt(x, riverTop, this.terrainTime);
      canvas.put(x, surface, '▄', this.palette.meadow, canvas.cell(x, surface)?.background);
      for (let y = surface + 1; y < riverTop; y += 1) {
        canvas.setBackground(x, y, mixColor(this.palette.meadow, this.palette.meadowLight, (y - surface) / 5));
      }
      if (x % 7 === Math.floor(this.terrainTime * 0.5) % 7) {
        canvas.put(x, surface - 1, x % 2 ? '\'' : '˵', this.palette.meadowLight);
      }
    }
  }

  private drawWrappedTrees(canvas: Canvas, riverTop: number): void {
    const rowsFor = (large: boolean): string[] => large
      ? ['   ▲   ', '  ▲▲▲  ', ' ▲▲▲▲▲ ', '   │   ', '   │   ']
      : ['  ▲  ', ' ▲▲▲ ', '  │  ', '  │  '];
    const span = canvas.width + 24;
    for (const [index, anchor] of [0.11, 0.36, 0.63, 0.88].entries()) {
      const base = anchor * canvas.width - this.terrainTime * (0.35 + index * 0.04);
      for (const shift of [-span, 0, span]) {
        const x = Math.round(base + shift);
        const ground = meadowSurfaceAt(x, riverTop, this.terrainTime);
        const rows = rowsFor(index % 3 === 0);
        for (const [row, value] of rows.entries()) {
          for (const [offset, character] of Array.from(value).entries()) {
            if (character === ' ') continue;
            canvas.put(
              x + offset,
              ground - rows.length + row,
              character,
              character === '│' ? this.palette.trunk : this.palette.tree,
              undefined,
              character !== '│',
            );
          }
        }
      }
    }
  }

  private paintRiver(canvas: Canvas, riverTop: number, hudTop: number): void {
    const riverHeight = Math.max(1, hudTop - riverTop);
    for (let y = riverTop; y < hudTop; y += 1) {
      canvas.fillBackground(
        0,
        y,
        canvas.width,
        1,
        mixColor(this.palette.riverTop, this.palette.riverBottom, (y - riverTop) / Math.max(1, riverHeight - 1)),
      );
    }
  }

  private drawRiverDetails(canvas: Canvas, riverTop: number, hudTop: number): void {
    const waveRows = Math.max(1, hudTop - riverTop);
    for (let row = 0; row < waveRows; row += 1) {
      const y = riverTop + row;
      const spacing = 8 + (row % 3) * 3;
      const offset = Math.floor(this.riverTime * (1.2 + row * 0.08));
      for (let x = -spacing; x < canvas.width + spacing; x += spacing) {
        const waveX = modulo(x - offset + row * 4, canvas.width + spacing) - 2;
        canvas.text(waveX, y, row % 2 ? '≈' : '~', this.palette.waterLight);
      }
    }
    const reflectionX = Math.floor(canvas.width * 0.78);
    for (let y = riverTop; y < hudTop; y += 1) {
      const width = 1 + Math.floor((y - riverTop) * 0.35);
      for (let dx = -width; dx <= width; dx += 2) {
        if ((dx + y + this.frameNumber) % 3 === 0) canvas.put(reflectionX + dx, y, '·', this.palette.reflection);
      }
    }
  }

  private drawSunOrMoon(canvas: Canvas, skyHeight: number): void {
    const x = Math.floor(canvas.width * 0.78);
    const y = clamp(Math.floor(skyHeight * 0.28), 3, Math.max(3, skyHeight - 3));
    canvas.put(x - 2, y, '·', this.palette.sun);
    canvas.put(x + 2, y, '·', this.palette.sun);
    canvas.put(x, y - 1, '·', this.palette.sun);
    canvas.put(x, y + 1, '·', this.palette.sun);
    canvas.put(x, y, '●', this.palette.sun, undefined, true);
  }

  private drawBirds(canvas: Canvas, skyHeight: number): void {
    const flockX = modulo(Math.floor(canvas.width * 0.18 + this.actorTime * 0.9), canvas.width + 18) - 9;
    const y = clamp(Math.floor(skyHeight * 0.35), 3, skyHeight - 3);
    const wing = this.frameNumber % 8 < 4 ? '⌁' : 'v';
    canvas.put(flockX, y, wing, this.palette.text);
    canvas.put(flockX + 6, y + 1, wing, this.palette.text);
    canvas.put(flockX + 12, y, wing, this.palette.text);
  }

  private drawRunner(canvas: Canvas, riverTop: number): void {
    const frames = ['^..^>', '^.o^>', '^..^>', '^o.^>'];
    const runner = frames[Math.floor(this.actorTime * 7) % frames.length] ?? frames[0];
    const x = modulo(Math.floor(this.actorTime * 4.3) + 12, canvas.width + runner.length + 8) - runner.length;
    const ground = meadowSurfaceAt(x + 2, riverTop, this.terrainTime);
    canvas.text(x, ground - 1, runner, this.palette.animal, undefined, true, true);
  }

  private drawFisher(canvas: Canvas, riverTop: number): void {
    const span = canvas.width + 40;
    const origin = modulo(Math.floor(canvas.width * 0.70 - this.terrainTime * 0.18), span) - 12;
    const ground = meadowSurfaceAt(origin, riverTop, this.terrainTime);
    canvas.text(origin, ground - 3, ' o', this.palette.person, undefined, true, true);
    canvas.text(origin, ground - 2, '/|\\_______.', this.palette.person, undefined, false, true);
    canvas.text(origin, ground - 1, '/ \\        │', this.palette.person, undefined, false, true);
    canvas.put(origin + 11, riverTop, '·', this.palette.waterLight);
  }

  private drawBoat(canvas: Canvas, riverTop: number, hudTop: number): void {
    if (hudTop - riverTop < 2) return;
    const boat = '<____\\o/____>';
    const span = canvas.width + boat.length + 20;
    const x = modulo(Math.floor(canvas.width * 0.42 - this.riverTime * 0.65), span) - boat.length;
    const y = clamp(riverTop + Math.floor((hudTop - riverTop) * 0.48), riverTop, hudTop - 1);
    canvas.text(x, y, boat, this.palette.boat, undefined, true, true);
    canvas.put(x + 8, y - 1, this.frameNumber % 10 < 5 ? '/' : '\\', this.palette.person);
  }

  private drawMessageBox(canvas: Canvas, hudTop: number): void {
    const message = "We're making things better for you.";
    const innerWidth = Array.from(message).length + 4;
    const x = Math.floor((canvas.width - innerWidth - 2) / 2);
    const y = clamp(Math.floor(hudTop * 0.43), 4, hudTop - 3);
    const top = `╭${'─'.repeat(innerWidth)}╮`;
    const middle = `│  ${message}  │`;
    const bottom = `╰${'─'.repeat(innerWidth)}╯`;
    canvas.fillBackground(x, y, innerWidth + 2, 3, this.palette.hud);
    canvas.text(x, y, top, this.palette.accent, this.palette.hud, true);
    canvas.text(x, y + 1, middle, this.palette.text, this.palette.hud, true);
    canvas.text(x, y + 2, bottom, this.palette.accent, this.palette.hud, true);
  }

  private drawHud(canvas: Canvas, hudTop: number): void {
    for (let y = hudTop; y < canvas.height; y += 1) {
      canvas.fillBackground(0, y, canvas.width, 1, y % 2 === 0 ? this.palette.hud : this.palette.hudAlt);
    }
    for (let x = 0; x < canvas.width; x += 1) canvas.put(x, hudTop, '▀', this.palette.accent, this.palette.hud);

    const left = canvas.width >= 80 ? 3 : 1;
    const spinnerFrames = ['◐', '◓', '◑', '◒'];
    const spinner = spinnerFrames[Math.floor(this.actorTime * 6) % spinnerFrames.length] ?? '◐';
    const status = `${spinner}  WORKSPACE MIGRATION  ·  ${this.state.phase}`;
    canvas.text(
      left,
      hudTop + 1,
      truncateText(status, canvas.width - left - 2),
      this.state.progress >= 1 ? this.palette.success : this.palette.text,
      canvas.cell(left, hudTop + 1)?.background,
      true,
    );
    canvas.text(
      left,
      hudTop + 2,
      truncateText(this.state.detail, canvas.width - left - 2),
      this.palette.muted,
      canvas.cell(left, hudTop + 2)?.background,
    );

    const rate = formatRate(this.state.bytesPerSecond, this.state.filesPerSecond);
    const rateLabel = rate ? `${this.state.activityLabel ?? 'Processing'}  ${rate}` : `${this.palette.name} · local time`;
    const maximumBar = Math.max(10, canvas.width - Array.from(rateLabel).length - left - 8);
    const barWidth = Math.min(44, maximumBar);
    const filled = Math.round(this.state.progress * barWidth);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, barWidth - filled))}`;
    canvas.text(left, hudTop + 3, bar, this.palette.accent, canvas.cell(left, hudTop + 3)?.background);
    const rateX = Math.max(left + barWidth + 3, canvas.width - Array.from(rateLabel).length - 2);
    canvas.text(
      rateX,
      hudTop + 3,
      truncateText(rateLabel, Math.max(1, canvas.width - rateX - 1)),
      this.palette.muted,
      canvas.cell(rateX, hudTop + 3)?.background,
    );
  }

  private drawCompact(canvas: Canvas): void {
    canvas.centeredText(Math.max(1, Math.floor(canvas.height / 2) - 3), 'F L U J O', this.palette.title, true);
    canvas.centeredText(Math.max(2, Math.floor(canvas.height / 2) - 1), 'where ideas find their flow', this.palette.text);
    canvas.centeredText(
      Math.max(3, Math.floor(canvas.height / 2) + 1),
      truncateText(this.state.phase, canvas.width - 2),
      this.palette.success,
    );
    canvas.centeredText(
      canvas.height - 2,
      truncateText('Resize to at least 56 × 18 for the landscape', canvas.width - 2),
      this.palette.muted,
    );
  }

  private renderCanvas(canvas: Canvas): string {
    let output = this.needsClear ? `${ESC}2J` : '';
    this.needsClear = false;
    for (let y = 0; y < canvas.height; y += 1) {
      output += `${ESC}${y + 1};1H`;
      let priorStyle = '';
      for (const cell of canvas.cells[y] ?? []) {
        const nextStyle = `${colorKey(cell.foreground)}|${colorKey(cell.background)}|${cell.bold ? 1 : 0}`;
        if (nextStyle !== priorStyle) {
          output += styleSequence(cell.foreground, cell.background, cell.bold, this.trueColor);
          priorStyle = nextStyle;
        }
        output += cell.character;
      }
      const finalCell = canvas.cells[y]?.[canvas.width - 1];
      if (finalCell) output += styleSequence(finalCell.foreground, finalCell.background, false, this.trueColor);
      output += `${ESC}K`;
    }
    return `${output}${ESC}0m`;
  }
}
