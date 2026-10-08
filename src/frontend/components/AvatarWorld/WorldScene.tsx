'use client';
import { useEffect, useRef } from 'react';
import type { AvatarWorldSnapshot } from '@/shared/types/avatar';
import type { EyePhase } from './Eyes';
import { LANDMARK_POSITIONS, PLACE_KINDS, type WorldPlace } from './Watershed';
import styles from './world.module.css';

const hash = (n: number) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
const seed = (text: string) => [...text].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7);

/** Ambient terrain is decorative. Only stored entities supply the small lights;
 * only the actual work/voice phase changes the scene's activity. */
export default function WorldScene(props: { snapshot: AvatarWorldSnapshot | null; phase: EyePhase; level: number; exploring: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef(props); current.current = props;
  const repaint = useRef<(() => void) | null>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element || /jsdom/i.test(navigator.userAgent)) return;
    const ctx = element.getContext('2d', { alpha: false });
    if (!ctx) return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = query.matches, frame = 0, last = 0, width = 1, height = 1, ratio = 1, life = 0;
    const pointer = { x: 0, y: 0 }, target = { x: 0, y: 0 };
    const resize = () => {
      width = element.clientWidth; height = element.clientHeight;
      ratio = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(2_500_000 / Math.max(1, width * height)));
      element.width = Math.max(1, Math.round(width * ratio)); element.height = Math.max(1, Math.round(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(performance.now());
    };
    const draw = (now: number) => {
      const { snapshot, phase, level, exploring } = current.current;
      const t = reduced ? 0 : now / 1000;
      const active = phase === 'thinking' || phase === 'usingApp';
      const destination = snapshot?.workModel?.ready || (snapshot?.objects.length ?? 0) > 0 ? 1 : 0;
      life = reduced ? destination : life + (destination - life) * .04;
      pointer.x += (target.x - pointer.x) * .035; pointer.y += (target.y - pointer.y) * .035;
      ctx.fillStyle = '#050607'; ctx.fillRect(0, 0, width, height);
      const sky = ctx.createRadialGradient(width * .5, height * .42, 0, width * .5, height * .42, width * .65);
      sky.addColorStop(0, `rgba(184,198,202,${.06 + life * .06})`); sky.addColorStop(.55, 'rgba(94,111,117,.025)'); sky.addColorStop(1, 'rgba(5,6,7,0)');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < 68; i++) {
        const x = hash(i + 1) * width, y = hash(i + 301) * height * .52;
        ctx.fillStyle = `rgba(230,235,236,${(.04 + hash(i + 61) * .23) * (.7 + Math.sin(t * .18 + i) * .3)})`;
        ctx.beginPath(); ctx.arc(x + pointer.x * 3, y, .45 + hash(i + 120) * .6, 0, Math.PI * 2); ctx.fill();
      }
      // Broad illuminated ridges, then finer contours nearer the viewer.
      const ridge = (x: number, layer: number) => height * (.52 + layer * .055)
        + Math.sin(x / width * 5.8 + layer * .8) * height * (.027 + layer * .004)
        + Math.sin(x / width * 10.2 + layer * 1.8) * height * .026;
      for (let layer = 0; layer < 5; layer++) {
        const shift = reduced ? 0 : pointer.x * (layer + 1) * 4;
        ctx.beginPath(); ctx.moveTo(-20, height);
        for (let x = -20; x <= width + 20; x += 8) ctx.lineTo(x, ridge(x + shift, layer));
        ctx.lineTo(width + 20, height); ctx.closePath();
        const shade = 10 + layer * 3 + life * 2;
        ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 3})`; ctx.fill();
        ctx.strokeStyle = `rgba(195,206,210,${.035 + layer * .012})`; ctx.lineWidth = .8; ctx.stroke();
        for (let row = 0; row < 14; row++) {
          ctx.beginPath();
          for (let x = -20; x <= width + 20; x += 10) {
            const y = ridge(x + shift, layer) + row * (4 + layer * 1.2) + Math.sin(x / 90 + row * .15) * row * .55;
            if (x === -20) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `rgba(184,198,203,${(.012 + life * .008) * (1 - row / 18)})`; ctx.lineWidth = .65; ctx.stroke();
        }
      }
      const streamX = (p: number) => width * (.54 + Math.sin(p * 4.4 - 1.1) * (.015 + p * .12)) + pointer.x * 12 * p;
      const streamY = (p: number) => height * (.56 + p * .5);
      ctx.beginPath();
      for (let i = 0; i <= 100; i++) { const p = i / 100, x = streamX(p) - width * (.001 + p * p * .11), y = streamY(p); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      for (let i = 100; i >= 0; i--) { const p = i / 100; ctx.lineTo(streamX(p) + width * (.001 + p * p * .11), streamY(p)); }
      ctx.closePath();
      const water = ctx.createLinearGradient(0, height * .55, 0, height);
      water.addColorStop(0, '#69777b'); water.addColorStop(.3, '#243035'); water.addColorStop(1, '#101719');
      ctx.fillStyle = water; ctx.globalAlpha = .3 + life * .4; ctx.fill(); ctx.globalAlpha = 1;
      for (let i = 0; i < 56; i++) {
        const p = ((i / 56 + t * (active ? .018 : .005)) % 1);
        const spread = width * (.001 + p * p * .09), x = streamX(p), y = streamY(p);
        ctx.beginPath(); ctx.ellipse(x + Math.sin(t * .3 + i) * spread * .4, y, spread * (.15 + hash(i) * .6), .35 + p * 1.2, 0, 0, Math.PI);
        ctx.strokeStyle = `rgba(215,229,232,${(.025 + hash(i + 50) * .1) * (.4 + life * .6)})`; ctx.lineWidth = .7; ctx.stroke();
      }
      const size = Math.max(.62, Math.min(1.3, width / 1000));
      for (const place of Object.keys(LANDMARK_POSITIONS) as WorldPlace[]) {
        const count = snapshot?.objects.filter(object => object.kind === PLACE_KINDS[place]).length ?? 0;
        const inhabited = place === 'models' ? Boolean(snapshot?.workModel?.ready) : place === 'settings' || count > 0;
        const [px, py] = LANDMARK_POSITIONS[place];
        const x = Math.max(52, Math.min(width - 52, width * px / 100)), y = height * py / 100;
        ctx.save(); ctx.translate(x, y - 12); ctx.scale(size, size); ctx.globalAlpha = inhabited ? .9 : .3;
        ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(4, 19, 48, 12, -.1, 0, Math.PI * 2); ctx.fill();
        // Rounded stone bases make places feel planted in the terrain.
        ctx.fillStyle = '#161c1f'; ctx.beginPath(); ctx.ellipse(0, 9, 38, 15, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#343d40'; ctx.beginPath(); ctx.ellipse(0, 4, 38, 13, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(190,206,209,.18)'; ctx.lineWidth = 1; ctx.stroke();
        if (place === 'models' || place === 'meetings') {
          ctx.fillStyle = '#101619'; ctx.beginPath(); ctx.ellipse(0, 1, 26, 8, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = inhabited ? '#a6b8b9' : '#53666c'; ctx.beginPath(); ctx.ellipse(0, 0, 20, 5, 0, 0, Math.PI * 2); ctx.stroke();
          if (place === 'models') {
            ctx.fillStyle = '#7c9297'; ctx.beginPath(); ctx.moveTo(-6, -1); ctx.quadraticCurveTo(-12, -25, 0, -40); ctx.quadraticCurveTo(14, -23, 6, -1); ctx.closePath(); ctx.fill();
            ctx.fillStyle = '#d1dedb'; ctx.beginPath(); ctx.ellipse(-2, -23, 3, 11, .2, 0, Math.PI * 2); ctx.fill();
          } else {
            for (let i = 0; i < 4; i++) { const angle = i * Math.PI / 2 + .4; ctx.fillStyle = '#526165'; ctx.beginPath(); ctx.ellipse(Math.cos(angle) * 30, Math.sin(angle) * 9 - 4, 5, 6, 0, 0, Math.PI * 2); ctx.fill(); }
          }
        } else if (place === 'apps') {
          ctx.fillStyle = '#566469'; ctx.beginPath(); ctx.moveTo(-30, -4); ctx.quadraticCurveTo(0, 22, 30, -4); ctx.lineTo(23, -8); ctx.lineTo(-23, -8); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = '#a4b2b4'; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(0, -48); ctx.stroke();
          ctx.fillStyle = '#c6cecb'; ctx.beginPath(); ctx.moveTo(-2, -45); ctx.quadraticCurveTo(-26, -28, -2, -15); ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#879796'; ctx.beginPath(); ctx.moveTo(3, -43); ctx.quadraticCurveTo(31, -28, 3, -18); ctx.closePath(); ctx.fill();
        } else {
          ctx.fillStyle = '#293236'; ctx.beginPath(); ctx.roundRect(-22, -28, 39, 32, 6); ctx.fill();
          ctx.fillStyle = '#1b2529'; ctx.beginPath(); ctx.moveTo(17, -27); ctx.lineTo(31, -35); ctx.lineTo(31, -3); ctx.lineTo(17, 4); ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#778386'; ctx.beginPath(); ctx.moveTo(-28, -27); ctx.quadraticCurveTo(-14, -48, -4, -51); ctx.lineTo(26, -41); ctx.lineTo(17, -23); ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#455257'; ctx.beginPath(); ctx.moveTo(17, -23); ctx.lineTo(26, -41); ctx.lineTo(37, -32); ctx.lineTo(31, -27); ctx.closePath(); ctx.fill();
          ctx.fillStyle = inhabited ? '#d2d9c8' : '#4b595d'; ctx.beginPath(); ctx.roundRect(-13, -21, 8, 10, 3); ctx.fill();
          ctx.fillStyle = '#11191c'; ctx.beginPath(); ctx.roundRect(4, -14, 9, 18, 4); ctx.fill();
          if (place === 'automations') {
            const running = snapshot?.objects.some(object => object.kind === 'automation' && object.state === 'running');
            ctx.save(); ctx.translate(1, -30); ctx.rotate(running ? t * .8 : 0); ctx.strokeStyle = '#b9c5c5'; ctx.lineWidth = 3;
            for (let i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ctx.beginPath(); ctx.moveTo(3, 0); ctx.lineTo(24, 0); ctx.stroke(); }
            ctx.restore(); ctx.fillStyle = '#d5ded9'; ctx.beginPath(); ctx.arc(1, -30, 4, 0, Math.PI * 2); ctx.fill();
          }
          if (place === 'archive') { ctx.fillStyle = '#536467'; ctx.beginPath(); ctx.roundRect(-33, -5, 14, 14, 3); ctx.fill(); ctx.strokeStyle = '#9aabac'; ctx.stroke(); }
        }
        // Plants grow from saved capability counts; no imaginary agents or jobs.
        for (let i = 0; i < Math.min(count, 5); i++) {
          const tx = (i % 2 ? -1 : 1) * (32 + i * 6), ty = 3 + i * 3;
          ctx.strokeStyle = '#526c65'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(tx - 3, ty - 11, tx, ty - 19); ctx.stroke();
          ctx.fillStyle = '#89988c'; ctx.beginPath(); ctx.ellipse(tx - 4, ty - 15, 7, 3.5, -.6, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.ellipse(tx + 4, ty - 22, 6, 3, .5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
      for (const object of snapshot?.objects.slice(0, 80) ?? []) {
        const id = seed(`${object.kind}:${object.id}`), p = .2 + hash(id) * .57;
        const side = hash(id + 3) > .5 ? 1 : -1;
        const x = streamX(p) + side * width * (.04 + hash(id + 1) * .2), y = streamY(p) - height * .035;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 14 + p * 14);
        glow.addColorStop(0, 'rgba(214,223,218,.10)'); glow.addColorStop(1, 'rgba(214,223,218,0)');
        ctx.fillStyle = glow; ctx.fillRect(x - 30, y - 30, 60, 60);
        ctx.fillStyle = `rgba(228,232,222,${.35 + .18 * Math.sin(t * .4 + hash(id) * 10)})`;
        ctx.beginPath(); ctx.arc(x, y, .7 + p, 0, Math.PI * 2); ctx.fill();
      }
      // A single pool of light follows listening/speech, rather than an invented progress counter.
      const breath = phase === 'speaking' || phase === 'listening' ? level : active ? .18 + Math.sin(t * 1.6) * .06 : .02;
      const halo = ctx.createRadialGradient(width * .5, height * .52, 0, width * .5, height * .52, width * .26);
      halo.addColorStop(0, `rgba(215,229,228,${.025 + breath * .055})`); halo.addColorStop(1, 'rgba(215,229,228,0)');
      ctx.fillStyle = halo; ctx.fillRect(0, 0, width, height);
      const mist = ctx.createLinearGradient(0, height * .48, 0, height * .72);
      mist.addColorStop(0, 'rgba(150,175,181,0)'); mist.addColorStop(.5, `rgba(150,175,181,${.025 + life * .025})`); mist.addColorStop(1, 'rgba(150,175,181,0)');
      ctx.fillStyle = mist; ctx.fillRect(0, 0, width, height);
      const vignette = ctx.createRadialGradient(width * .5, height * .48, width * .18, width * .5, height * .48, Math.max(width, height) * .65);
      vignette.addColorStop(0, 'rgba(0,0,0,0)'); vignette.addColorStop(1, `rgba(0,0,0,${exploring ? .38 : .7})`);
      ctx.fillStyle = vignette; ctx.fillRect(0, 0, width, height);
    };
    const tick = (now: number) => {
      if (document.hidden || reduced) { frame = 0; return; }
      if (now - last >= 40) { draw(now); last = now; }
      frame = requestAnimationFrame(tick);
    };
    const resume = () => { cancelAnimationFrame(frame); draw(performance.now()); if (!reduced && !document.hidden) frame = requestAnimationFrame(tick); };
    repaint.current = () => { if (reduced && !document.hidden) draw(performance.now()); };
    const move = (event: PointerEvent) => { if (reduced) return; target.x = (event.clientX / innerWidth - .5) * 2; target.y = (event.clientY / innerHeight - .5) * 2; };
    const motion = () => { reduced = query.matches; target.x = target.y = pointer.x = pointer.y = 0; resume(); };
    const observer = new ResizeObserver(resize); observer.observe(element);
    window.addEventListener('pointermove', move, { passive: true }); document.addEventListener('visibilitychange', resume); query.addEventListener('change', motion);
    resize(); resume();
    return () => { repaint.current = null; cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('pointermove', move); document.removeEventListener('visibilitychange', resume); query.removeEventListener('change', motion); };
  }, []);
  useEffect(() => { repaint.current?.(); }, [props.snapshot, props.phase, props.exploring]);
  return <canvas ref={canvas} className={styles.worldScene} aria-hidden="true" />;
}
