#!/usr/bin/env node
/**
 * Standalone FLUJO migration-landscape experiment.
 *
 * This deliberately has no application imports and changes no migration state.
 * It explores the terminal capabilities needed by a future full-screen startup
 * experience: alternate-screen ownership, true-color backgrounds, resize-safe
 * full-frame drawing, parallax scrolling, animation, raw-key input and reliable
 * terminal restoration.
 *
 * Run:
 *   npm run demo:migration-ui
 *   node scripts/migration-landscape-demo.mjs --duration=10
 *
 * Keys:
 *   q / Esc   quit
 *   Space     pause/resume
 *   p         cycle landscape palette
 *   c         toggle true-color / ANSI-256 rendering
 */
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const ESC = '\u001B[';
const argv = process.argv.slice(2);

function argumentValue(name) {
  const inline = argv.find(argument => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numericArgument(name, fallback, minimum, maximum) {
  const parsed = Number(argumentValue(name));
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`FLUJO migration landscape demo

Usage:
  node scripts/migration-landscape-demo.mjs [options]

Options:
  --fps=<n>         Frames per second (default: 10, range: 2-30)
  --duration=<sec>  Exit automatically after this many seconds
  --256             Start with ANSI-256 instead of true-color
  --palette=<name>  twilight, daybreak, or moonlight (default: local time)
  --no-alt          Draw in the current screen instead of the alternate screen
  --force           Run even when stdout is not a TTY (useful for smoke tests)
  --help            Show this message

Keys: q/Esc quit, Space pause, p palette, c color depth`);
  process.exit(0);
}

const force = argv.includes('--force');
const useAlternateScreen = !argv.includes('--no-alt');
const fps = numericArgument('--fps', 10, 2, 30);
const durationSeconds = numericArgument('--duration', 0, 0, 24 * 60 * 60);

if (!process.stdout.isTTY && !force) {
  console.error(
    'The landscape demo needs a terminal. Run it directly, or pass --force only for automated smoke tests.',
  );
  process.exit(1);
}

const PALETTES = [
  {
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
  },
  {
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
  },
  {
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
  },
];

const requestedPalette = argumentValue('--palette')?.toLowerCase();
const localHour = new Date().getHours();
const localPalette = localHour >= 5 && localHour < 17
  ? 'daybreak'
  : localHour >= 17 && localHour < 21 ? 'twilight' : 'moonlight';
let paletteIndex = Math.max(0, PALETTES.findIndex(
  palette => palette.name.toLowerCase() === (requestedPalette ?? localPalette),
));
let colorMode = argv.includes('--256') ? 'ansi256' : 'truecolor';
let paused = false;
let sceneSeconds = 0;
let lastFrameAt = performance.now();
let frameNumber = 0;
let needsClear = true;
let canWrite = true;
let restored = false;
let interval;
let durationTimer;
let rawInputEnabled = false;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function mixColor(from, to, amount) {
  const t = clamp(amount, 0, 1);
  return from.map((channel, index) => Math.round(channel + (to[index] - channel) * t));
}

function colorKey(color) {
  return color.join(',');
}

function rgbToAnsi256([red, green, blue]) {
  const r = Math.round((red / 255) * 5);
  const g = Math.round((green / 255) * 5);
  const b = Math.round((blue / 255) * 5);
  return 16 + (36 * r) + (6 * g) + b;
}

function styleSequence(foreground, background, bold = false) {
  if (colorMode === 'ansi256') {
    return `${ESC}0${bold ? ';1' : ''};38;5;${rgbToAnsi256(foreground)};48;5;${rgbToAnsi256(background)}m`;
  }
  return `${ESC}0${bold ? ';1' : ''};38;2;${foreground.join(';')};48;2;${background.join(';')}m`;
}

class Canvas {
  constructor(width, height, backgroundAt, foreground) {
    this.width = width;
    this.height = height;
    this.cells = Array.from({ length: height }, (_row, y) =>
      Array.from({ length: width }, () => ({
        character: ' ',
        foreground,
        background: backgroundAt(y),
        bold: false,
      })),
    );
  }

  cell(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    return this.cells[y][x];
  }

  put(x, y, character, foreground, background, bold = false) {
    const cell = this.cell(Math.round(x), Math.round(y));
    if (!cell) return;
    cell.character = character;
    if (foreground) cell.foreground = foreground;
    if (background) cell.background = background;
    cell.bold = bold;
  }

  setBackground(x, y, background) {
    const cell = this.cell(x, y);
    if (!cell) return;
    cell.character = ' ';
    cell.foreground = background;
    cell.background = background;
    cell.bold = false;
  }

  fillBackground(x, y, width, height, background) {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row += 1) {
      for (let column = Math.max(0, x); column < Math.min(this.width, x + width); column += 1) {
        this.setBackground(column, row, background);
      }
    }
  }

  text(x, y, value, foreground, background, bold = false, transparentSpaces = false) {
    for (const [offset, character] of Array.from(value).entries()) {
      if (transparentSpaces && character === ' ') continue;
      this.put(x + offset, y, character, foreground, background, bold);
    }
  }

  centeredText(y, value, foreground, background, bold = false) {
    const length = Array.from(value).length;
    this.text(Math.floor((this.width - length) / 2), y, value, foreground, background, bold);
  }
}

function hash(index) {
  let value = (index + 1) * 2654435761;
  value ^= value >>> 16;
  value = Math.imul(value, 2246822519);
  value ^= value >>> 13;
  return (value >>> 0) / 0xFFFFFFFF;
}

function drawStars(canvas, palette, skyHeight, time) {
  const count = Math.max(16, Math.floor(canvas.width / 4));
  for (let index = 0; index < count; index += 1) {
    const x = Math.floor(modulo(hash(index) * canvas.width - time * 0.05, canvas.width));
    const y = 2 + Math.floor(hash(index + 101) * Math.max(1, skyHeight - 5));
    const shimmer = Math.sin(time * 1.4 + index * 2.1) > 0.72;
    canvas.put(x, y, shimmer ? '✦' : '·', palette.star, undefined, shimmer);
  }
}

function drawCloud(canvas, x, y, palette) {
  const rows = [
    '       .--.      ',
    '   .--(    ).    ',
    '  (__________)   ',
  ];
  for (const [row, value] of rows.entries()) {
    canvas.text(x, y + row, value, palette.cloud, undefined, false, true);
  }
}

function drawWrappedCloud(canvas, origin, y, palette) {
  const span = canvas.width + 24;
  for (const shift of [-span, 0, span]) drawCloud(canvas, Math.round(origin + shift), y, palette);
}

function mountainHeight(x, offset, period, amplitude) {
  const phase = modulo(x + offset, period) / period;
  const triangle = 1 - Math.abs((phase * 2) - 1);
  return 1 + triangle * amplitude + Math.sin((x + offset) * 0.13) * 0.8;
}

function paintMountainLayer(canvas, {
  base,
  amplitude,
  period,
  offset,
  color,
  snow,
  snowLine = 0.74,
}) {
  for (let x = 0; x < canvas.width; x += 1) {
    const height = mountainHeight(x, offset, period, amplitude);
    const surface = clamp(Math.round(base - height), 2, base - 1);
    const boundary = height >= amplitude * snowLine ? snow : color;
    const priorBackground = canvas.cell(x, surface)?.background;
    canvas.put(x, surface, '▄', boundary, priorBackground);
    for (let y = surface + 1; y < base; y += 1) canvas.setBackground(x, y, color);
  }
}

function meadowSurfaceAt(x, riverTop, time) {
  return riverTop - 2 - Math.round(Math.sin((x + time * 0.7) * 0.09) * 0.7);
}

function paintMeadow(canvas, palette, riverTop, time) {
  for (let x = 0; x < canvas.width; x += 1) {
    const surface = meadowSurfaceAt(x, riverTop, time);
    const priorBackground = canvas.cell(x, surface)?.background;
    canvas.put(x, surface, '▄', palette.meadow, priorBackground);
    for (let y = surface + 1; y < riverTop; y += 1) {
      canvas.setBackground(x, y, mixColor(palette.meadow, palette.meadowLight, (y - surface) / 5));
    }
    if (x % 7 === Math.floor(time * 0.5) % 7) {
      canvas.put(x, surface - 1, x % 2 ? '\'' : '˵', palette.meadowLight);
    }
  }
}

function drawTree(canvas, x, ground, palette, scale = 1) {
  const rows = scale > 1
    ? ['   ▲   ', '  ▲▲▲  ', ' ▲▲▲▲▲ ', '   │   ', '   │   ']
    : ['  ▲  ', ' ▲▲▲ ', '  │  ', '  │  '];
  for (const [row, value] of rows.entries()) {
    const y = ground - rows.length + row;
    for (const [offset, character] of Array.from(value).entries()) {
      if (character === ' ') continue;
      canvas.put(
        x + offset,
        y,
        character,
        character === '│' ? palette.trunk : palette.tree,
        undefined,
        character !== '│',
      );
    }
  }
}

function drawWrappedTrees(canvas, palette, riverTop, time) {
  const span = canvas.width + 24;
  const anchors = [0.11, 0.36, 0.63, 0.88];
  for (const [index, anchor] of anchors.entries()) {
    const base = anchor * canvas.width - time * (0.35 + index * 0.04);
    for (const shift of [-span, 0, span]) {
      const x = Math.round(base + shift);
      const ground = meadowSurfaceAt(x, riverTop, time);
      drawTree(canvas, x, ground, palette, index % 3 === 0 ? 2 : 1);
    }
  }
}

function paintRiver(canvas, palette, riverTop, hudTop) {
  const riverHeight = Math.max(1, hudTop - riverTop);
  for (let y = riverTop; y < hudTop; y += 1) {
    const color = mixColor(
      palette.riverTop,
      palette.riverBottom,
      (y - riverTop) / Math.max(1, riverHeight - 1),
    );
    canvas.fillBackground(0, y, canvas.width, 1, color);
  }
}

function drawRiverDetails(canvas, palette, riverTop, hudTop, time) {
  const waveRows = Math.max(1, hudTop - riverTop);
  for (let row = 0; row < waveRows; row += 1) {
    const y = riverTop + row;
    const spacing = 8 + (row % 3) * 3;
    const offset = Math.floor(time * (1.2 + row * 0.08));
    for (let x = -spacing; x < canvas.width + spacing; x += spacing) {
      const waveX = modulo(x - offset + row * 4, canvas.width + spacing) - 2;
      canvas.text(waveX, y, row % 2 ? '≈' : '~', palette.waterLight, undefined);
    }
  }

  const reflectionX = Math.floor(canvas.width * 0.78);
  for (let y = riverTop; y < hudTop; y += 1) {
    const width = 1 + Math.floor((y - riverTop) * 0.35);
    for (let dx = -width; dx <= width; dx += 2) {
      if ((dx + y + frameNumber) % 3 === 0) {
        canvas.put(reflectionX + dx, y, '·', palette.reflection);
      }
    }
  }
}

function drawSunOrMoon(canvas, palette, skyHeight) {
  const x = Math.floor(canvas.width * 0.78);
  const y = clamp(Math.floor(skyHeight * 0.28), 3, Math.max(3, skyHeight - 3));
  canvas.put(x - 2, y, '·', palette.sun);
  canvas.put(x + 2, y, '·', palette.sun);
  canvas.put(x, y - 1, '·', palette.sun);
  canvas.put(x, y + 1, '·', palette.sun);
  canvas.put(x, y, '●', palette.sun, undefined, true);
}

function drawBirds(canvas, palette, skyHeight, time) {
  const flockX = modulo(Math.floor(canvas.width * 0.18 + time * 0.9), canvas.width + 18) - 9;
  const y = clamp(Math.floor(skyHeight * 0.35), 3, skyHeight - 3);
  const wing = frameNumber % 8 < 4 ? '⌁' : 'v';
  canvas.put(flockX, y, wing, palette.text);
  canvas.put(flockX + 6, y + 1, wing, palette.text);
  canvas.put(flockX + 12, y, wing, palette.text);
}

function drawRunner(canvas, palette, riverTop, time) {
  const frames = ['^..^>', '^.o^>', '^..^>', '^o.^>'];
  const runner = frames[Math.floor(time * 7) % frames.length];
  const x = modulo(Math.floor(time * 4.3) + 12, canvas.width + runner.length + 8) - runner.length;
  const ground = meadowSurfaceAt(x + 2, riverTop, time);
  canvas.text(x, ground - 1, runner, palette.animal, undefined, true, true);
}

function drawFisher(canvas, palette, riverTop, time) {
  const span = canvas.width + 40;
  const origin = modulo(Math.floor(canvas.width * 0.70 - time * 0.18), span) - 12;
  const ground = meadowSurfaceAt(origin, riverTop, time);
  canvas.text(origin, ground - 3, ' o', palette.person, undefined, true, true);
  canvas.text(origin, ground - 2, '/|\\_______.', palette.person, undefined, false, true);
  canvas.text(origin, ground - 1, '/ \\        │', palette.person, undefined, false, true);
  if (ground < canvas.height) canvas.put(origin + 11, riverTop, '·', palette.waterLight);
}

function drawBoat(canvas, palette, riverTop, hudTop, time) {
  if (hudTop - riverTop < 2) return;
  const boat = '<____\\o/____>';
  const span = canvas.width + boat.length + 20;
  const x = modulo(Math.floor(canvas.width * 0.42 - time * 0.65), span) - boat.length;
  const y = clamp(riverTop + Math.floor((hudTop - riverTop) * 0.48), riverTop, hudTop - 1);
  canvas.text(x, y, boat, palette.boat, undefined, true, true);
  const paddle = frameNumber % 10 < 5 ? '/' : '\\';
  canvas.put(x + 8, y - 1, paddle, palette.person);
}

function drawMessageBox(canvas, palette, hudTop) {
  const message = "We're making things better for you.";
  const innerWidth = Array.from(message).length + 4;
  const x = Math.floor((canvas.width - innerWidth - 2) / 2);
  const y = clamp(Math.floor(hudTop * 0.43), 4, hudTop - 3);
  const top = `╭${'─'.repeat(innerWidth)}╮`;
  const middle = `│  ${message}  │`;
  const bottom = `╰${'─'.repeat(innerWidth)}╯`;
  canvas.fillBackground(x, y, innerWidth + 2, 3, palette.hud);
  canvas.text(x, y, top, palette.accent, palette.hud, true);
  canvas.text(x, y + 1, middle, palette.text, palette.hud, true);
  canvas.text(x, y + 2, bottom, palette.accent, palette.hud, true);
}

function truncateText(value, maximum) {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  if (maximum <= 1) return '…'.slice(0, maximum);
  return `${characters.slice(0, maximum - 1).join('')}…`;
}

function migrationState(time) {
  const cycle = modulo(time, 36) / 36;
  if (cycle < 0.48) {
    return {
      phase: 'Verifying legacy workspace data',
      progress: cycle / 0.48 * 0.55,
      detail: `${Math.floor(1240 + cycle * 210000)} files  ·  ${(0.7 + cycle * 18).toFixed(2)} GiB`,
    };
  }
  if (cycle < 0.78) {
    return {
      phase: 'Publishing the new workspace layout',
      progress: 0.55 + ((cycle - 0.48) / 0.30) * 0.30,
      detail: `${Math.min(11, 1 + Math.floor((cycle - 0.48) / 0.03))}/11 locations`,
    };
  }
  if (cycle < 0.94) {
    return {
      phase: 'Cleaning up the completed transaction',
      progress: 0.85 + ((cycle - 0.78) / 0.16) * 0.14,
      detail: 'Your original data remains recoverable',
    };
  }
  return {
    phase: 'Workspace migration complete',
    progress: 1,
    detail: 'Everything is right where it should be',
  };
}

function drawHud(canvas, palette, hudTop, time) {
  const hudHeight = canvas.height - hudTop;
  for (let y = hudTop; y < canvas.height; y += 1) {
    canvas.fillBackground(
      0,
      y,
      canvas.width,
      1,
      y % 2 === 0 ? palette.hud : palette.hudAlt,
    );
  }
  for (let x = 0; x < canvas.width; x += 1) {
    canvas.put(x, hudTop, '▀', palette.accent, palette.hud);
  }

  const state = migrationState(time);
  const spinnerFrames = ['◐', '◓', '◑', '◒'];
  const spinner = paused ? 'Ⅱ' : spinnerFrames[Math.floor(time * 6) % spinnerFrames.length];
  const statusRow = Math.min(canvas.height - 1, hudTop + 1);
  const detailRow = Math.min(canvas.height - 1, hudTop + 2);
  const controlsRow = Math.min(canvas.height - 1, hudTop + 3);
  const left = canvas.width >= 80 ? 3 : 1;

  canvas.text(
    left,
    statusRow,
    truncateText(`${spinner}  WORKSPACE MIGRATION  ·  ${state.phase}`, canvas.width - left - 2),
    state.progress === 1 ? palette.success : palette.text,
    canvas.cell(left, statusRow)?.background,
    true,
  );
  canvas.text(
    left,
    detailRow,
    truncateText(state.detail, canvas.width - left - 2),
    palette.muted,
    canvas.cell(left, detailRow)?.background,
  );

  if (hudHeight >= 4) {
    const controls = canvas.width >= 100
      ? `Q quit  ·  SPACE ${paused ? 'resume' : 'pause'}  ·  P scene: ${palette.name}  ·  C color: ${colorMode === 'truecolor' ? '24-bit' : '256'}`
      : `Q quit  ·  SPACE ${paused ? 'resume' : 'pause'}  ·  P scene  ·  C color`;
    const maximumBar = Math.max(8, canvas.width - Array.from(controls).length - left - 8);
    const barWidth = Math.min(44, maximumBar);
    const filled = Math.round(state.progress * barWidth);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, barWidth - filled))}`;
    canvas.text(left, controlsRow, bar, palette.accent, canvas.cell(left, controlsRow)?.background);
    canvas.text(
      Math.max(left + barWidth + 3, canvas.width - Array.from(controls).length - 2),
      controlsRow,
      truncateText(controls, Math.max(1, canvas.width - left - barWidth - 5)),
      palette.muted,
      canvas.cell(left, controlsRow)?.background,
    );
  }
}

function drawCompact(canvas, palette, time) {
  const state = migrationState(time);
  canvas.centeredText(
    Math.max(1, Math.floor(canvas.height / 2) - 3),
    'F L U J O',
    palette.title,
    undefined,
    true,
  );
  canvas.centeredText(
    Math.max(2, Math.floor(canvas.height / 2) - 1),
    'where ideas find their flow',
    palette.text,
  );
  canvas.centeredText(
    Math.max(3, Math.floor(canvas.height / 2) + 1),
    truncateText(state.phase, canvas.width - 2),
    palette.success,
  );
  canvas.centeredText(
    canvas.height - 2,
    'Resize to at least 56 × 18 for the landscape  ·  Q quits',
    palette.muted,
  );
}

function buildFrame(time) {
  const terminalColumns = process.stdout.columns || Number(process.env.COLUMNS) || 100;
  const terminalRows = process.stdout.rows || Number(process.env.LINES) || 30;
  // Leave the final physical column untouched. Some terminal hosts wrap after
  // writing it even when auto-wrap has just been disabled.
  const width = Math.max(24, terminalColumns - 1);
  const height = Math.max(10, terminalRows);
  const palette = PALETTES[paletteIndex];
  const skyHeight = Math.max(6, Math.floor(height * 0.58));
  const backgroundAt = y => mixColor(
    palette.skyTop,
    palette.skyBottom,
    y / Math.max(1, skyHeight - 1),
  );
  const canvas = new Canvas(width, height, backgroundAt, palette.text);

  if (width < 56 || height < 18) {
    drawCompact(canvas, palette, time);
    return canvas;
  }

  const hudHeight = height >= 24 ? 4 : 3;
  const hudTop = height - hudHeight;
  const riverTop = clamp(Math.floor(height * 0.64), 11, hudTop - 2);
  const mountainBase = riverTop;

  drawStars(canvas, palette, Math.max(5, riverTop - 5), time);
  drawSunOrMoon(canvas, palette, Math.max(7, riverTop - 4));
  drawWrappedCloud(canvas, modulo(width * 0.14 - time * 0.22, width + 24) - 12, 4, palette);
  drawWrappedCloud(canvas, modulo(width * 0.61 - time * 0.13, width + 24) - 12, 6, palette);

  paintMountainLayer(canvas, {
    base: mountainBase,
    amplitude: Math.max(4, height * 0.22),
    period: Math.max(24, width * 0.31),
    offset: time * 0.22,
    color: palette.farMountain,
    snow: palette.snow,
  });
  paintMountainLayer(canvas, {
    base: mountainBase,
    amplitude: Math.max(3, height * 0.15),
    period: Math.max(18, width * 0.22),
    offset: time * 0.48 + 9,
    color: palette.nearMountain,
    snow: palette.nearMountain,
    snowLine: 2,
  });

  paintRiver(canvas, palette, riverTop, hudTop);
  paintMeadow(canvas, palette, riverTop, time);
  drawRiverDetails(canvas, palette, riverTop, hudTop, time);
  drawWrappedTrees(canvas, palette, riverTop, time);
  drawBirds(canvas, palette, riverTop - 4, time);
  drawRunner(canvas, palette, riverTop, time);
  drawFisher(canvas, palette, riverTop, time);
  drawBoat(canvas, palette, riverTop, hudTop, time);
  drawMessageBox(canvas, palette, hudTop);

  canvas.centeredText(1, 'F L U J O', palette.title, undefined, true);
  if (height >= 22) {
    canvas.centeredText(2, 'where ideas find their flow', palette.text);
  }
  drawHud(canvas, palette, hudTop, time);
  return canvas;
}

function renderCanvas(canvas) {
  let output = needsClear ? `${ESC}2J` : '';
  needsClear = false;
  for (let y = 0; y < canvas.height; y += 1) {
    output += `${ESC}${y + 1};1H`;
    let priorStyle = '';
    for (const cell of canvas.cells[y]) {
      const nextStyle = `${colorKey(cell.foreground)}|${colorKey(cell.background)}|${cell.bold ? 1 : 0}`;
      if (nextStyle !== priorStyle) {
        output += styleSequence(cell.foreground, cell.background, cell.bold);
        priorStyle = nextStyle;
      }
      output += cell.character;
    }
    // Paint the deliberately unused final column with the row's base color.
    const finalCell = canvas.cells[y][canvas.width - 1];
    output += styleSequence(finalCell.foreground, finalCell.background, false);
    output += `${ESC}K`;
  }
  output += `${ESC}0m`;
  return output;
}

function render(now = performance.now()) {
  if (!canWrite) return;
  const delta = Math.min(0.25, Math.max(0, (now - lastFrameAt) / 1000));
  lastFrameAt = now;
  if (!paused) sceneSeconds += delta;
  frameNumber += 1;
  const frame = renderCanvas(buildFrame(sceneSeconds));
  canWrite = process.stdout.write(frame);
  if (!canWrite) {
    process.stdout.once('drain', () => {
      canWrite = true;
      needsClear = true;
    });
  }
}

function restoreTerminal() {
  if (restored) return;
  restored = true;
  if (interval) clearInterval(interval);
  if (durationTimer) clearTimeout(durationTimer);
  if (rawInputEnabled && process.stdin.setRawMode) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Terminal may already be detached during shutdown.
    }
  }
  if (rawInputEnabled) process.stdin.pause();
  const leaveAlternate = useAlternateScreen ? `${ESC}?1049l` : '';
  try {
    process.stdout.write(`${ESC}0m${ESC}?7h${leaveAlternate}${ESC}?25h`);
  } catch {
    // Best effort during process teardown.
  }
}

function shutdown(code = 0) {
  restoreTerminal();
  process.exit(code);
}

function enterTerminal() {
  const enterAlternate = useAlternateScreen ? `${ESC}?1049h` : '';
  process.stdout.write(`${enterAlternate}${ESC}?25l${ESC}?7l${ESC}2J${ESC}H`);
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    rawInputEnabled = true;
    process.stdin.on('data', input => {
      for (const key of Array.from(input)) {
        if (key === 'q' || key === 'Q' || key === '\u001B' || key === '\u0003') shutdown(0);
        if (key === ' ') paused = !paused;
        if (key === 'p' || key === 'P') {
          paletteIndex = (paletteIndex + 1) % PALETTES.length;
          needsClear = true;
        }
        if (key === 'c' || key === 'C') {
          colorMode = colorMode === 'truecolor' ? 'ansi256' : 'truecolor';
          needsClear = true;
        }
      }
    });
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => shutdown(signal === 'SIGINT' ? 130 : 0));
}
process.once('exit', restoreTerminal);
process.once('uncaughtException', error => {
  restoreTerminal();
  console.error(error);
  process.exit(1);
});
process.once('unhandledRejection', error => {
  restoreTerminal();
  console.error(error);
  process.exit(1);
});
process.stdout.on('resize', () => {
  needsClear = true;
  render();
});
process.stdout.on('error', error => {
  if (error?.code === 'EPIPE') process.exit(0);
  throw error;
});

enterTerminal();
render();
interval = setInterval(() => render(), 1000 / fps);
if (durationSeconds > 0) {
  durationTimer = setTimeout(() => shutdown(0), durationSeconds * 1000);
}
