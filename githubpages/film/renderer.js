import { FILM, SHOTS, SCENES, DURATION } from './timeline.js';
export { FILM, SHOTS, SCENES, DURATION };

const FONT = '"Segoe UI", Arial, sans-serif';
const COLORS = { background: '#0a0c12', text: '#f6f7fa', secondary: '#bec3d0', accent: '#7964ee' };
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };

export function sceneAt(time) {
  const t = clamp(Number.isFinite(time) ? time : 0, 0, DURATION);
  const index = SCENES.findIndex(scene => t >= scene.start && t < scene.end);
  return index < 0 ? SCENES.length - 1 : index;
}

export function shotAt(time) {
  const t = clamp(Number.isFinite(time) ? time : 0, 0, DURATION);
  return SHOTS.find(shot => t >= shot.start && t < shot.end) || SHOTS.at(-1);
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function drawLines(ctx, lines, x, firstY, lineHeight) {
  lines.forEach((line, index) => ctx.fillText(line, x, firstY + index * lineHeight));
}

function drawNarration(ctx, shot, width, height) {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (shot.label) {
    ctx.font = '500 27px ' + FONT;
    ctx.fillStyle = COLORS.secondary;
    ctx.fillText(shot.label, width / 2, height * .2);
  }
  ctx.font = '650 72px ' + FONT;
  const title = wrapText(ctx, shot.title, width * .79);
  ctx.font = '400 48px ' + FONT;
  const body = wrapText(ctx, shot.text, width * .76);
  const titleHeight = title.length * 91;
  const bodyHeight = body.length * 65;
  const gap = title.length && body.length ? 38 : 0;
  const top = (height - titleHeight - bodyHeight - gap) / 2 + 30;
  ctx.font = '650 72px ' + FONT;
  ctx.fillStyle = COLORS.text;
  drawLines(ctx, title, width / 2, top + 45, 91);
  ctx.font = '400 48px ' + FONT;
  ctx.fillStyle = COLORS.secondary;
  drawLines(ctx, body, width / 2, top + titleHeight + gap + 33, 65);
}

function viewForKey(key, width, height) {
  if (key.view) return key.view;
  if (!key.focus || !key.zoom || key.zoom <= 1) return [0, 0, width, height];
  const [x, y, w, h] = key.focus;
  const viewWidth = width / key.zoom, viewHeight = height / key.zoom;
  return [
    clamp(x + w / 2 - viewWidth / 2, 0, width - viewWidth),
    clamp(y + h / 2 - viewHeight / 2, 0, height - viewHeight),
    viewWidth, viewHeight,
  ];
}

function cameraAt(shot, time, width, height, reducedMotion) {
  const keys = shot.camera || [{ at: 0 }];
  if (reducedMotion) {
    const still = shot.gentleCamera || keys.at(-1);
    return viewForKey(still, width, height);
  }
  if (time <= keys[0].at) return viewForKey(keys[0], width, height);
  for (let i = 1; i < keys.length; i++) {
    if (time > keys[i].at) continue;
    const previous = keys[i - 1], next = keys[i];
    const from = viewForKey(previous, width, height), to = viewForKey(next, width, height);
    const progress = smooth((time - previous.at) / Math.max(.001, next.at - previous.at));
    return from.map((value, index) => value + (to[index] - value) * progress);
  }
  return viewForKey(keys.at(-1), width, height);
}

function pointerAt(shot, time) {
  // The video clock stays clamped during a hold. Editorial pointer travel uses
  // presentation time so it can approach an early recorded click during that hold.
  const offset = (shot.holdLead || 0) - (shot.sourceStart || 0);
  let previous = shot.initialPointer ? { at: 0, ...shot.initialPointer } : null;
  for (const recorded of shot.events || []) {
    if (!Number.isFinite(recorded.x) || !Number.isFinite(recorded.y)) continue;
    const event = { ...recorded, at: recorded.at + offset };
    if (event.at >= time) {
      if (!previous) return time >= event.at ? event : null;
      const moveStart = Math.max(previous.at, event.at - (event.travelSeconds || .65));
      const progress = smooth((time - moveStart) / Math.max(.001, event.at - moveStart));
      return { x: previous.x + (event.x - previous.x) * progress, y: previous.y + (event.y - previous.y) * progress };
    }
    previous = event;
  }
  return previous;
}

function drawPointer(ctx, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 31);
  ctx.lineTo(8, 24);
  ctx.lineTo(14, 39);
  ctx.lineTo(21, 36);
  ctx.lineTo(14, 21);
  ctx.lineTo(25, 21);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#181827';
  ctx.lineWidth = 2.8;
  ctx.lineJoin = 'round';
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawFootage(ctx, shot, time, width, height, images, reducedMotion) {
  const entry = images[shot.id] || images[shot.source];
  const source = entry?.video || entry?.image;
  if (!source) {
    drawNarration(ctx, {
      title: 'The recording is not available.',
      text: 'Use the chapter notes while this source is being prepared.',
    }, width, height);
    return;
  }
  const sourceWidth = source.videoWidth || source.naturalWidth || width;
  const sourceHeight = source.videoHeight || source.naturalHeight || height;
  const camera = cameraAt(shot, time, sourceWidth, sourceHeight, reducedMotion);
  const scale = Math.min(width / camera[2], height / camera[3]);
  const displayWidth = camera[2] * scale, displayHeight = camera[3] * scale;
  const left = (width - displayWidth) / 2, top = (height - displayHeight) / 2;
  const project = (x, y) => [left + (x - camera[0]) * scale, top + (y - camera[1]) * scale];

  ctx.fillStyle = '#08090d';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, displayWidth, displayHeight);
  ctx.clip();
  ctx.drawImage(source, ...camera, left, top, displayWidth, displayHeight);

  for (const target of shot.highlights || []) {
    if (time < target.start || time > target.end) continue;
    const [x, y, w, h] = target.rect;
    const [px, py] = project(x, y);
    ctx.beginPath();
    ctx.roundRect(px, py, w * scale, h * scale, Math.min(10, h * scale / 4));
    ctx.strokeStyle = target.color || COLORS.accent;
    ctx.lineWidth = 5;
    ctx.stroke();
  }

  // The source has no pointer. This editorial pointer follows the capture's
  // logged target coordinates; only recorded clicks receive a click halo.
  const pointerTime = reducedMotion && shot.stillTime != null
    ? shot.stillTime - (shot.sourceStart || 0) + (shot.holdLead || 0) : time;
  const pointer = pointerAt(shot, pointerTime);
  if (!reducedMotion) {
    for (const event of shot.events || []) {
      if (event.type !== 'click') continue;
      const clickAt = (shot.holdLead || 0) + event.at - (shot.sourceStart || 0);
      const age = time - clickAt;
      if (age < 0 || age > .65) continue;
      const [x, y] = project(event.x, event.y);
      ctx.save();
      ctx.globalAlpha = 1 - age / .65;
      ctx.strokeStyle = '#6c50e6';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, 11 + age * 37, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
  if (pointer) drawPointer(ctx, ...project(pointer.x, pointer.y));
  ctx.restore();
}

export function drawFilm(context, time, width, height, options = {}) {
  const shot = shotAt(time);
  if (!shot) return;
  const stageWidth = FILM.width || 1600, stageHeight = FILM.height || 1000;
  const scale = Math.min(width / stageWidth, height / stageHeight);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = COLORS.background;
  context.fillRect(0, 0, width, height);
  context.translate((width - stageWidth * scale) / 2, (height - stageHeight * scale) / 2);
  context.scale(scale, scale);
  const local = clamp(time - shot.start, 0, shot.duration);
  if (options.mediaStatus === 'loading') {
    drawNarration(context, { title: 'Loading walkthrough', text: 'Preparing the recorded footage.' }, stageWidth, stageHeight);
  } else if (shot.type === 'footage') {
    drawFootage(context, shot, local, stageWidth, stageHeight, options.images || {}, Boolean(options.reducedMotion));
  } else drawNarration(context, shot, stageWidth, stageHeight);
  context.restore();
}
