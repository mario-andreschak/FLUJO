import type { LandmarkKind, RiverScene, RiverSceneId } from './sceneMap';
import { themeColors } from '@/frontend/utils/paletteTokens';
import { flowNodeColors } from '@/frontend/utils/flowPaletteTokens';

export interface RiverCamera {
  x: number;
  y: number;
  zoom: number;
}
export interface RiverPointer {
  x: number;
  y: number;
}

export interface RiverRenderFrame {
  width: number;
  height: number;
  time: number;
  dark: boolean;
  camera: RiverCamera;
  pointer: RiverPointer;
  activeScene: RiverSceneId;
  scenes: readonly RiverScene[];
}

interface RiverPalette {
  skyTop: string;
  skyBottom: string;
  halo: string;
  star: string;
  hillFar: string;
  hillNear: string;
  grass: string;
  grassLight: string;
  bank: string;
  waterTop: string;
  waterBottom: string;
  waterLine: string;
  trunk: string;
  leaf: string;
  leafLight: string;
  structure: string;
  structureDark: string;
  window: string;
  mist: string;
}

const WORLD_X_SCALE = 130;
const TAU = Math.PI * 2;
const MAX_CANVAS_PIXEL_RATIO = 1.6;
const MAX_CANVAS_PIXELS = 5_000_000;
const WORLD_VIEW_CENTER_Y = 0.49;
const POINTER_PARALLAX_Y = 8;
const WORLD_FILL_MARGIN = 180;

const LIGHT_PALETTE: RiverPalette = {
  skyTop: themeColors.light.background,
  skyBottom: themeColors.light.surfaceRaised,
  halo: 'rgba(99, 85, 232, 0.20)',
  star: 'rgba(255,255,255,0)',
  hillFar: themeColors.light.border,
  hillNear: themeColors.light.textDisabled,
  grass: themeColors.light.domain.signal,
  grassLight: flowNodeColors.dark.signal,
  bank: themeColors.light.surface,
  waterTop: flowNodeColors.dark.mcp,
  waterBottom: flowNodeColors.light.process,
  waterLine: 'rgba(255,255,255,0.72)',
  trunk: themeColors.light.textSecondary,
  leaf: flowNodeColors.light.resource,
  leafLight: flowNodeColors.dark.resource,
  structure: themeColors.light.surfaceRaised,
  structureDark: themeColors.light.textSecondary,
  window: flowNodeColors.dark.subflow,
  mist: 'rgba(245,247,255,0.34)',
};

const DARK_PALETTE: RiverPalette = {
  skyTop: themeColors.dark.background,
  skyBottom: themeColors.dark.surface,
  halo: 'rgba(139, 124, 255, 0.28)',
  star: 'rgba(244,246,255,0.84)',
  hillFar: themeColors.dark.surface,
  hillNear: themeColors.dark.surfaceRaised,
  grass: themeColors.dark.domain.signal,
  grassLight: flowNodeColors.light.signal,
  bank: themeColors.dark.border,
  waterTop: flowNodeColors.light.mcp,
  waterBottom: flowNodeColors.dark.process,
  waterLine: 'rgba(49,210,237,0.42)',
  trunk: themeColors.dark.textDisabled,
  leaf: flowNodeColors.light.resource,
  leafLight: flowNodeColors.dark.resource,
  structure: themeColors.dark.surfaceRaised,
  structureDark: themeColors.dark.border,
  window: flowNodeColors.dark.subflow,
  mist: 'rgba(139,124,255,0.12)',
};

const hash = (value: number) => {
  const sine = Math.sin(value * 12.9898) * 43758.5453;
  return sine - Math.floor(sine);
};

const rgba = (hex: string, alpha: number) => {
  const normalized = hex.replace('#', '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((part) => `${part}${part}`).join('')
    : normalized;
  const value = Number.parseInt(expanded, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
};

const roundedRect = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const resolvedRadius = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  context.beginPath();
  context.moveTo(x + resolvedRadius, y);
  context.lineTo(x + width - resolvedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + resolvedRadius);
  context.lineTo(x + width, y + height - resolvedRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - resolvedRadius, y + height);
  context.lineTo(x + resolvedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - resolvedRadius);
  context.lineTo(x, y + resolvedRadius);
  context.quadraticCurveTo(x, y, x + resolvedRadius, y);
  context.closePath();
};

export const sceneWorldX = (scene: RiverScene) => (scene.x - 50) * WORLD_X_SCALE;

export function canvasPixelRatioForViewport(
  width: number,
  height: number,
  devicePixelRatio: number,
) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const requestedRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const pixelBudgetRatio = Math.sqrt(MAX_CANVAS_PIXELS / (safeWidth * safeHeight));

  return Math.min(requestedRatio, MAX_CANVAS_PIXEL_RATIO, pixelBudgetRatio);
}

export const riverBankY = (x: number) => (
  145
  + Math.sin(x * 0.00105) * 42
  + Math.sin(x * 0.00245 + 1.7) * 19
);

export const sceneWorldY = (scene: RiverScene) => (
  riverBankY(sceneWorldX(scene)) - 44 + (scene.y - 50) * 2.25
);

export const cameraForScene = (scene: RiverScene): RiverCamera => ({
  x: sceneWorldX(scene),
  y: sceneWorldY(scene) - 82,
  zoom: scene.zoom,
});

export const riverFillBottom = (
  height: number,
  camera: RiverCamera,
  pointer: RiverPointer,
) => {
  const visibleWorldBottom = camera.y + (
    height * (1 - WORLD_VIEW_CENTER_Y) - pointer.y * POINTER_PARALLAX_Y
  ) / camera.zoom;

  return Math.max(960, visibleWorldBottom + WORLD_FILL_MARGIN);
};

function drawSky(
  context: CanvasRenderingContext2D,
  frame: RiverRenderFrame,
  palette: RiverPalette,
) {
  const { width, height, time, camera, dark } = frame;
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, palette.skyTop);
  gradient.addColorStop(0.72, palette.skyBottom);
  gradient.addColorStop(1, dark ? themeColors.dark.surfaceRaised : themeColors.light.border);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  const orbX = width * 0.82 - ((camera.x * 0.012) % (width * 0.16));
  const orbY = height * 0.18;
  const halo = context.createRadialGradient(orbX, orbY, 0, orbX, orbY, height * 0.3);
  halo.addColorStop(0, palette.halo);
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = halo;
  context.fillRect(0, 0, width, height * 0.72);

  context.save();
  context.fillStyle = dark ? themeColors.dark.foreground : themeColors.light.surface;
  context.shadowColor = palette.halo;
  context.shadowBlur = 28;
  context.beginPath();
  context.arc(orbX, orbY, dark ? 20 : 29, 0, TAU);
  context.fill();
  if (dark) {
    context.globalCompositeOperation = 'destination-out';
    context.fillStyle = '#000';
    context.beginPath();
    context.arc(orbX + 8, orbY - 7, 18, 0, TAU);
    context.fill();
  }
  context.restore();

  if (dark) {
    context.fillStyle = palette.star;
    for (let index = 0; index < 46; index += 1) {
      const x = hash(index * 7.13) * width;
      const y = 18 + hash(index * 13.71) * height * 0.44;
      const pulse = 0.45 + Math.sin(time * 0.0012 + index) * 0.3;
      context.globalAlpha = Math.max(0.16, pulse);
      context.beginPath();
      context.arc(x, y, 0.7 + hash(index * 5.3) * 1.1, 0, TAU);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  context.save();
  context.globalAlpha = dark ? 0.12 : 0.18;
  context.fillStyle = dark ? '#91aec7' : '#ffffff';
  for (let index = 0; index < 5; index += 1) {
    const travel = ((time * (0.003 + index * 0.0004) + index * width * 0.31) % (width + 360)) - 180;
    const cloudY = height * (0.12 + index * 0.055);
    context.beginPath();
    context.ellipse(travel, cloudY, 95 + index * 12, 18 + index * 2, 0, 0, TAU);
    context.ellipse(travel + 58, cloudY + 3, 70, 14, 0, 0, TAU);
    context.fill();
  }
  context.restore();
}

function drawHillBand(
  context: CanvasRenderingContext2D,
  minX: number,
  maxX: number,
  baseY: number,
  amplitude: number,
  frequency: number,
  color: string,
  phase: number,
  bottomY: number,
) {
  context.beginPath();
  context.moveTo(minX, bottomY);
  context.lineTo(minX, baseY);
  for (let x = minX; x <= maxX; x += 90) {
    const y = baseY
      - Math.abs(Math.sin(x * frequency + phase)) * amplitude
      - Math.abs(Math.sin(x * frequency * 0.41 + phase * 2.2)) * amplitude * 0.52;
    context.lineTo(x, y);
  }
  context.lineTo(maxX, bottomY);
  context.closePath();
  context.fillStyle = color;
  context.fill();
}

function traceBank(
  context: CanvasRenderingContext2D,
  minX: number,
  maxX: number,
  offset = 0,
) {
  context.moveTo(minX, riverBankY(minX) + offset);
  for (let x = minX + 70; x <= maxX; x += 70) {
    context.lineTo(x, riverBankY(x) + offset);
  }
}

function drawLandAndWater(
  context: CanvasRenderingContext2D,
  frame: RiverRenderFrame,
  palette: RiverPalette,
) {
  const viewRadius = Math.max(1600, frame.width / Math.max(frame.camera.zoom, 0.8) * 0.8);
  const minX = frame.camera.x - viewRadius;
  const maxX = frame.camera.x + viewRadius;
  const fillBottom = riverFillBottom(frame.height, frame.camera, frame.pointer);

  drawHillBand(context, minX - 500, maxX + 500, 115, 170, 0.00072, palette.hillFar, 0.8, fillBottom);
  drawHillBand(context, minX - 500, maxX + 500, 148, 112, 0.0011, palette.hillNear, 2.3, fillBottom);

  const grassGradient = context.createLinearGradient(0, 80, 0, 420);
  grassGradient.addColorStop(0, palette.grassLight);
  grassGradient.addColorStop(1, palette.grass);
  context.beginPath();
  traceBank(context, minX - 500, maxX + 500);
  context.lineTo(maxX + 500, fillBottom);
  context.lineTo(minX - 500, fillBottom);
  context.closePath();
  context.fillStyle = grassGradient;
  context.fill();

  context.beginPath();
  traceBank(context, minX - 500, maxX + 500, 45);
  context.lineTo(maxX + 500, fillBottom);
  context.lineTo(minX - 500, fillBottom);
  context.closePath();
  context.fillStyle = palette.bank;
  context.fill();

  const waterGradient = context.createLinearGradient(0, 170, 0, 780);
  waterGradient.addColorStop(0, palette.waterTop);
  waterGradient.addColorStop(1, palette.waterBottom);
  context.beginPath();
  traceBank(context, minX - 500, maxX + 500, 67);
  context.lineTo(maxX + 500, fillBottom);
  context.lineTo(minX - 500, fillBottom);
  context.closePath();
  context.fillStyle = waterGradient;
  context.fill();

  context.save();
  context.lineCap = 'round';
  for (let row = 0; row < 10; row += 1) {
    const yOffset = 98 + row * 34;
    const speed = frame.time * (0.018 + row * 0.0008);
    context.beginPath();
    for (let x = minX - 120; x <= maxX + 120; x += 34) {
      const y = riverBankY(x) + yOffset + Math.sin((x + speed) * 0.014 + row) * 4;
      if (x === minX - 120) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = palette.waterLine;
    context.globalAlpha = 0.1 + (row % 3) * 0.035;
    context.lineWidth = row % 3 === 0 ? 2.1 : 1.1;
    context.setLineDash([30 + row * 3, 70 + row * 5]);
    context.lineDashOffset = -speed * (0.35 + row * 0.02);
    context.stroke();
  }
  context.restore();
}

function drawTree(
  context: CanvasRenderingContext2D,
  x: number,
  baseY: number,
  height: number,
  palette: RiverPalette,
  time: number,
  seed: number,
) {
  const sway = Math.sin(time * 0.00055 + seed * 8) * 2.4;
  context.save();
  context.translate(x, baseY);
  context.strokeStyle = palette.trunk;
  context.lineWidth = Math.max(3, height * 0.06);
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(0, 5);
  context.quadraticCurveTo(sway * 0.3, -height * 0.46, sway, -height * 0.78);
  context.stroke();

  context.fillStyle = palette.leaf;
  context.beginPath();
  context.ellipse(sway, -height * 0.76, height * 0.28, height * 0.37, sway * 0.008, 0, TAU);
  context.ellipse(-height * 0.18 + sway, -height * 0.61, height * 0.24, height * 0.31, -0.35, 0, TAU);
  context.ellipse(height * 0.17 + sway, -height * 0.6, height * 0.25, height * 0.3, 0.4, 0, TAU);
  context.fill();

  context.globalAlpha = 0.48;
  context.fillStyle = palette.leafLight;
  context.beginPath();
  context.ellipse(-height * 0.08 + sway, -height * 0.83, height * 0.13, height * 0.18, -0.4, 0, TAU);
  context.fill();
  context.restore();
}

function drawTrees(
  context: CanvasRenderingContext2D,
  frame: RiverRenderFrame,
  palette: RiverPalette,
) {
  const minX = frame.camera.x - Math.max(1700, frame.width / frame.camera.zoom);
  const maxX = frame.camera.x + Math.max(1700, frame.width / frame.camera.zoom);
  const landmarkXs = frame.scenes.map(sceneWorldX);
  const start = Math.floor(minX / 150) * 150;
  for (let x = start; x <= maxX; x += 150) {
    const seed = hash(x * 0.17);
    if (seed < 0.2 || landmarkXs.some((landmarkX) => Math.abs(landmarkX - x) < 180)) continue;
    const height = 58 + seed * 68;
    const baseY = riverBankY(x) + 9;
    drawTree(context, x + (seed - 0.5) * 70, baseY, height, palette, frame.time, seed);
  }
}

function drawLantern(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  palette: RiverPalette,
  glow: string,
  scale = 1,
) {
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  context.strokeStyle = palette.structureDark;
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(0, -48);
  context.lineTo(10, -48);
  context.stroke();
  context.fillStyle = glow;
  context.shadowColor = glow;
  context.shadowBlur = 22;
  roundedRect(context, 3, -55, 17, 20, 5);
  context.fill();
  context.restore();
}

function drawOverlook(context: CanvasRenderingContext2D, palette: RiverPalette, accent: string, time: number) {
  context.fillStyle = palette.structureDark;
  roundedRect(context, -94, -18, 188, 21, 7);
  context.fill();
  context.fillRect(-72, 0, 8, 25);
  context.fillRect(64, 0, 8, 25);
  drawLantern(context, -74, -14, palette, accent, 0.82);
  drawLantern(context, 74, -14, palette, accent, 0.82);
  context.strokeStyle = rgba(accent, 0.62);
  context.lineWidth = 2;
  context.beginPath();
  context.arc(0, -25, 31 + Math.sin(time * 0.0015) * 3, Math.PI * 0.1, Math.PI * 0.9);
  context.stroke();
}

function drawSpring(context: CanvasRenderingContext2D, palette: RiverPalette, accent: string, time: number) {
  context.fillStyle = rgba(accent, 0.23);
  context.beginPath();
  context.ellipse(0, 6, 92, 25, 0, 0, TAU);
  context.fill();
  context.strokeStyle = rgba(accent, 0.75);
  context.lineWidth = 3;
  context.beginPath();
  context.ellipse(0, 4, 75 + Math.sin(time * 0.002) * 5, 17, 0, 0, TAU);
  context.stroke();
  [-46, 0, 43].forEach((x, index) => {
    const height = 74 + index * 24;
    context.save();
    context.translate(x, 0);
    context.fillStyle = index === 1 ? accent : rgba(accent, 0.68);
    context.shadowColor = accent;
    context.shadowBlur = index === 1 ? 28 : 16;
    context.beginPath();
    context.moveTo(-13, 0);
    context.lineTo(-8, -height + 18);
    context.lineTo(0, -height);
    context.lineTo(10, -height + 20);
    context.lineTo(14, 0);
    context.closePath();
    context.fill();
    context.restore();
  });
}

function drawHarbor(context: CanvasRenderingContext2D, palette: RiverPalette, accent: string, time: number) {
  context.strokeStyle = palette.structureDark;
  context.lineWidth = 12;
  context.beginPath();
  context.moveTo(-110, 0);
  context.quadraticCurveTo(0, -116, 110, 0);
  context.stroke();
  context.strokeStyle = palette.structure;
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(-110, -2);
  context.quadraticCurveTo(0, -105, 110, -2);
  context.stroke();
  for (let index = 0; index < 4; index += 1) {
    const phase = (time * 0.00011 + index / 4) % 1;
    const x = -98 + phase * 196;
    const y = -4 - (1 - Math.pow((phase - 0.5) * 2, 2)) * 79;
    context.fillStyle = accent;
    context.shadowColor = accent;
    context.shadowBlur = 15;
    context.beginPath();
    context.arc(x, y, 5, 0, TAU);
    context.fill();
  }
  context.shadowBlur = 0;
}

function drawWorkshop(context: CanvasRenderingContext2D, palette: RiverPalette, accent: string, time: number) {
  const stations = [
    { x: -72, y: -22 },
    { x: 0, y: -82 },
    { x: 78, y: -18 },
  ];
  context.strokeStyle = rgba(accent, 0.7);
  context.lineWidth = 3;
  context.setLineDash([7, 9]);
  context.lineDashOffset = -time * 0.012;
  context.beginPath();
  context.moveTo(stations[0].x, stations[0].y);
  context.lineTo(stations[1].x, stations[1].y);
  context.lineTo(stations[2].x, stations[2].y);
  context.stroke();
  context.setLineDash([]);
  stations.forEach((station, index) => {
    context.fillStyle = index === 1 ? accent : palette.structure;
    context.strokeStyle = palette.structureDark;
    context.lineWidth = 5;
    context.shadowColor = index === 1 ? accent : 'transparent';
    context.shadowBlur = index === 1 ? 22 : 0;
    context.beginPath();
    context.moveTo(station.x, station.y - 24);
    context.lineTo(station.x + 25, station.y - 4);
    context.lineTo(station.x + 14, station.y + 24);
    context.lineTo(station.x - 18, station.y + 24);
    context.lineTo(station.x - 26, station.y - 5);
    context.closePath();
    context.fill();
    context.stroke();
  });
  context.shadowBlur = 0;
}

function drawCove(context: CanvasRenderingContext2D, palette: RiverPalette, accent: string, time: number) {
  context.fillStyle = palette.structureDark;
  roundedRect(context, -100, -7, 200, 16, 7);
  context.fill();
  const bob = Math.sin(time * 0.002) * 4;
  [-47, 47].forEach((x, index) => {
    context.fillStyle = index === 0 ? accent : palette.window;
    context.shadowColor = index === 0 ? accent : palette.window;
    context.shadowBlur = 25;
    roundedRect(context, x - 29, -77 - bob * (index ? -1 : 1), 58, 43, 18);
    context.fill();
    context.beginPath();
    context.moveTo(x + (index ? -11 : 11), -37 - bob * (index ? -1 : 1));
    context.lineTo(x + (index ? -2 : 2), -27 - bob * (index ? -1 : 1));
    context.lineTo(x + (index ? -20 : 20), -34 - bob * (index ? -1 : 1));
    context.closePath();
    context.fill();
  });
  context.shadowBlur = 0;
}

function drawLockworks(context: CanvasRenderingContext2D, palette: RiverPalette, accent: string, time: number) {
  context.fillStyle = palette.structure;
  context.strokeStyle = palette.structureDark;
  context.lineWidth = 6;
  roundedRect(context, -95, -91, 92, 91, 10);
  context.fill();
  context.stroke();
  context.fillStyle = palette.window;
  context.shadowColor = palette.window;
  context.shadowBlur = 12;
  roundedRect(context, -71, -65, 34, 26, 6);
  context.fill();
  context.shadowBlur = 0;
  context.save();
  context.translate(51, -38);
  context.rotate(time * 0.00035);
  context.strokeStyle = accent;
  context.lineWidth = 7;
  context.beginPath();
  context.arc(0, 0, 45, 0, TAU);
  context.stroke();
  for (let index = 0; index < 8; index += 1) {
    context.rotate(TAU / 8);
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(0, -55);
    context.stroke();
  }
  context.fillStyle = palette.structureDark;
  context.beginPath();
  context.arc(0, 0, 10, 0, TAU);
  context.fill();
  context.restore();
}

function drawObservatory(context: CanvasRenderingContext2D, palette: RiverPalette, accent: string, time: number) {
  context.fillStyle = palette.structureDark;
  roundedRect(context, -73, -52, 146, 53, 10);
  context.fill();
  context.fillStyle = palette.structure;
  context.beginPath();
  context.arc(0, -53, 62, Math.PI, TAU);
  context.lineTo(62, -52);
  context.lineTo(-62, -52);
  context.closePath();
  context.fill();
  context.strokeStyle = accent;
  context.lineWidth = 3;
  context.beginPath();
  context.arc(0, -53, 41, Math.PI + 0.3, TAU - 0.3);
  context.stroke();
  for (let ring = 0; ring < 3; ring += 1) {
    const radius = 72 + ((time * 0.025 + ring * 32) % 85);
    context.strokeStyle = rgba(accent, Math.max(0, 0.35 - (radius - 72) / 260));
    context.lineWidth = 2;
    context.beginPath();
    context.arc(0, -53, radius, Math.PI * 1.12, Math.PI * 1.88);
    context.stroke();
  }
}

function drawMarket(context: CanvasRenderingContext2D, palette: RiverPalette, accent: string, time: number) {
  const stalls = [-72, 0, 72];
  stalls.forEach((x, index) => {
    const flutter = Math.sin(time * 0.0017 + index) * 3;
    context.fillStyle = palette.structureDark;
    roundedRect(context, x - 29, -55, 58, 57, 6);
    context.fill();
    context.fillStyle = index === 1 ? accent : palette.structure;
    context.beginPath();
    context.moveTo(x - 39, -54);
    context.lineTo(x + 36, -54 + flutter);
    context.lineTo(x + 24, -85 + flutter);
    context.lineTo(x - 27, -85);
    context.closePath();
    context.fill();
  });
  context.fillStyle = rgba(palette.window, 0.82);
  context.beginPath();
  context.arc(-96, -12, 5, 0, TAU);
  context.arc(99, -16, 5, 0, TAU);
  context.fill();
}

function drawGauge(context: CanvasRenderingContext2D, palette: RiverPalette, accent: string, time: number) {
  context.fillStyle = palette.structureDark;
  roundedRect(context, -32, -142, 64, 144, 10);
  context.fill();
  context.fillStyle = palette.structure;
  context.beginPath();
  context.moveTo(-44, -139);
  context.lineTo(0, -178);
  context.lineTo(44, -139);
  context.closePath();
  context.fill();
  context.fillStyle = accent;
  context.shadowColor = accent;
  context.shadowBlur = 25;
  context.beginPath();
  context.arc(0, -137, 11, 0, TAU);
  context.fill();
  context.save();
  context.translate(0, -137);
  context.rotate(Math.sin(time * 0.00065) * 0.72);
  const beam = context.createLinearGradient(0, 0, 230, 0);
  beam.addColorStop(0, rgba(accent, 0.3));
  beam.addColorStop(1, rgba(accent, 0));
  context.fillStyle = beam;
  context.beginPath();
  context.moveTo(0, -8);
  context.lineTo(235, -47);
  context.lineTo(235, 47);
  context.lineTo(0, 8);
  context.closePath();
  context.fill();
  context.restore();
  context.shadowBlur = 0;
}

function drawArchive(context: CanvasRenderingContext2D, palette: RiverPalette, accent: string, time: number) {
  context.fillStyle = palette.structureDark;
  roundedRect(context, -93, -100, 186, 101, 12);
  context.fill();
  context.fillStyle = palette.structure;
  context.beginPath();
  context.moveTo(-111, -96);
  context.lineTo(0, -156);
  context.lineTo(111, -96);
  context.closePath();
  context.fill();
  for (let index = 0; index < 4; index += 1) {
    const x = -61 + index * 41;
    context.fillStyle = index === Math.floor((time * 0.0003) % 4) ? accent : palette.window;
    context.shadowColor = context.fillStyle as string;
    context.shadowBlur = 11;
    roundedRect(context, x, -73, 24, 35, 4);
    context.fill();
  }
  context.shadowBlur = 0;
}

function drawControlHouse(context: CanvasRenderingContext2D, palette: RiverPalette, accent: string, time: number) {
  context.fillStyle = palette.structureDark;
  roundedRect(context, -82, -95, 164, 96, 12);
  context.fill();
  context.fillStyle = palette.structure;
  context.beginPath();
  context.moveTo(-98, -91);
  context.lineTo(0, -146);
  context.lineTo(98, -91);
  context.closePath();
  context.fill();
  context.fillStyle = palette.window;
  context.shadowColor = palette.window;
  context.shadowBlur = 13;
  roundedRect(context, -48, -70, 38, 31, 6);
  context.fill();
  context.shadowBlur = 0;
  [accent, flowNodeColors.dark.resource, flowNodeColors.dark.subflow].forEach((color, index) => {
    context.fillStyle = color;
    context.beginPath();
    context.arc(22 + index * 18, -54, 4 + Math.sin(time * 0.002 + index), 0, TAU);
    context.fill();
  });
  context.strokeStyle = palette.structureDark;
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(0, -143);
  context.lineTo(0, -177);
  context.lineTo(Math.cos(time * 0.00045) * 22, -177 + Math.sin(time * 0.00045) * 8);
  context.stroke();
}

const LANDMARK_DRAWERS: Record<LandmarkKind, (
  context: CanvasRenderingContext2D,
  palette: RiverPalette,
  accent: string,
  time: number,
) => void> = {
  overlook: drawOverlook,
  spring: drawSpring,
  harbor: drawHarbor,
  workshop: drawWorkshop,
  cove: drawCove,
  lockworks: drawLockworks,
  observatory: drawObservatory,
  market: drawMarket,
  gauge: drawGauge,
  archive: drawArchive,
  'control-house': drawControlHouse,
};

function drawLandmarks(
  context: CanvasRenderingContext2D,
  frame: RiverRenderFrame,
  palette: RiverPalette,
) {
  for (const scene of frame.scenes) {
    const x = sceneWorldX(scene);
    const y = sceneWorldY(scene);
    if (Math.abs(x - frame.camera.x) > Math.max(1800, frame.width / frame.camera.zoom)) continue;
    const active = scene.id === frame.activeScene;

    context.save();
    context.translate(x, y);
    context.globalAlpha = active ? 1 : 0.56;

    if (active) {
      const aura = context.createRadialGradient(0, -62, 4, 0, -62, 190);
      aura.addColorStop(0, rgba(scene.accent, frame.dark ? 0.24 : 0.2));
      aura.addColorStop(1, rgba(scene.accent, 0));
      context.fillStyle = aura;
      context.fillRect(-210, -270, 420, 390);
    }

    LANDMARK_DRAWERS[scene.landmark](context, palette, scene.accent, frame.time);

    if (active) {
      const pulse = 0.65 + Math.sin(frame.time * 0.0022) * 0.22;
      context.strokeStyle = rgba(scene.accent, pulse);
      context.lineWidth = 2;
      context.beginPath();
      context.ellipse(0, 12, 116 + pulse * 18, 20 + pulse * 3, 0, 0, TAU);
      context.stroke();
    }
    context.restore();
  }
}

function drawMotes(
  context: CanvasRenderingContext2D,
  frame: RiverRenderFrame,
  palette: RiverPalette,
) {
  const radius = Math.max(1150, frame.width / frame.camera.zoom * 0.65);
  context.save();
  for (let index = 0; index < 34; index += 1) {
    const seedX = hash(index * 19.71 + Math.floor(frame.camera.x / 2200) * 4.3);
    const x = frame.camera.x + (seedX - 0.5) * radius * 2;
    const baseY = riverBankY(x) - 35 - hash(index * 8.2) * 175;
    const y = baseY + Math.sin(frame.time * 0.0009 + index * 1.7) * 13;
    const alpha = 0.2 + (Math.sin(frame.time * 0.002 + index * 0.8) + 1) * 0.21;
    context.fillStyle = index % 4 === 0 ? palette.window : 'rgba(190,255,231,0.9)';
    context.globalAlpha = alpha;
    context.shadowColor = context.fillStyle as string;
    context.shadowBlur = 9;
    context.beginPath();
    context.arc(x, y, 1.4 + hash(index * 4.2) * 1.8, 0, TAU);
    context.fill();
  }
  context.restore();
}

function drawMist(
  context: CanvasRenderingContext2D,
  frame: RiverRenderFrame,
  palette: RiverPalette,
) {
  const radius = Math.max(1400, frame.width / frame.camera.zoom);
  context.save();
  context.fillStyle = palette.mist;
  context.globalAlpha = 0.42;
  for (let index = 0; index < 5; index += 1) {
    const travel = ((frame.time * (0.012 + index * 0.003) + index * 480) % (radius * 2.4)) - radius * 1.2;
    const x = frame.camera.x + travel;
    const y = 72 + index * 24;
    context.beginPath();
    context.ellipse(x, y, 280 + index * 40, 26 + index * 3, 0, 0, TAU);
    context.fill();
  }
  context.restore();
}

export function renderRiverWorld(
  context: CanvasRenderingContext2D,
  frame: RiverRenderFrame,
) {
  const palette = frame.dark ? DARK_PALETTE : LIGHT_PALETTE;
  context.clearRect(0, 0, frame.width, frame.height);
  drawSky(context, frame, palette);

  context.save();
  const parallaxX = frame.pointer.x * 16;
  const parallaxY = frame.pointer.y * 8;
  context.translate(frame.width * 0.5 + parallaxX, frame.height * WORLD_VIEW_CENTER_Y + parallaxY);
  context.scale(frame.camera.zoom, frame.camera.zoom);
  context.translate(-frame.camera.x, -frame.camera.y);
  drawLandAndWater(context, frame, palette);
  drawTrees(context, frame, palette);
  drawLandmarks(context, frame, palette);
  drawMotes(context, frame, palette);
  drawMist(context, frame, palette);
  context.restore();

  const lowerVeil = context.createLinearGradient(0, frame.height * 0.5, 0, frame.height);
  lowerVeil.addColorStop(0, 'rgba(0,0,0,0)');
  lowerVeil.addColorStop(1, frame.dark ? 'rgba(3,8,20,0.28)' : 'rgba(244,247,255,0.26)');
  context.fillStyle = lowerVeil;
  context.fillRect(0, frame.height * 0.5, frame.width, frame.height * 0.5);
}
