'use client';
"use client";

// src/world/canonical/src/frontend/components/AvatarWorld/WorldScene.tsx
import { useEffect, useRef } from "react";

// src/world/canonical/src/frontend/components/AvatarWorld/world.module.css
var world_default = {
  world: "world_world",
  grain: "world_grain",
  topbar: "world_topbar",
  wordmark: "world_wordmark",
  topActions: "world_topActions",
  brain: "world_brain",
  mapToggle: "world_mapToggle",
  companion: "world_companion",
  presence: "world_presence",
  presenceDot: "world_presenceDot",
  welcome: "world_welcome",
  primary: "world_primary",
  textButton: "world_textButton",
  stylePicker: "world_stylePicker",
  eyes: "world_eyes",
  eye: "world_eye",
  blink: "world_blink",
  eyeHalo: "world_eyeHalo",
  ponder: "world_ponder",
  speak: "world_speak",
  smallEyes: "world_smallEyes",
  companionAside: "world_companionAside",
  mapLayer: "world_mapLayer",
  mapVisible: "world_mapVisible",
  watershed: "world_watershed",
  landscape: "world_landscape",
  terrain: "world_terrain",
  terrainFar: "world_terrainFar",
  riverBank: "world_riverBank",
  river: "world_river",
  reed: "world_reed",
  firefly: "world_firefly",
  landmark: "world_landmark",
  bottomBar: "world_bottomBar",
  composer: "world_composer",
  workControls: "world_workControls",
  attention: "world_attention",
  transcript: "world_transcript",
  message: "world_message",
  proposal: "world_proposal",
  error: "world_error",
  scrim: "world_scrim",
  setup: "world_setup",
  placeSheet: "world_placeSheet",
  sheetHead: "world_sheetHead",
  panelHead: "world_panelHead",
  eyebrow: "world_eyebrow",
  candidates: "world_candidates",
  candidate: "world_candidate",
  connectionForm: "world_connectionForm",
  help: "world_help",
  testDetails: "world_testDetails",
  object: "world_object",
  panel: "world_panel",
  resourceSheet: "world_resourceSheet",
  resourceActions: "world_resourceActions",
  identity: "world_identity",
  talkIdentity: "world_talkIdentity",
  worldScene: "world_worldScene",
  menuToggle: "world_menuToggle",
  controls: "world_controls",
  character: "world_character",
  characterFloat: "world_characterFloat",
  characterShadow: "world_characterShadow",
  shadowFloat: "world_shadowFloat",
  caption: "world_caption",
  landmarkTarget: "world_landmarkTarget"
};

// src/world/canonical/src/frontend/components/AvatarWorld/Watershed.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var LANDMARK_POSITIONS = {
  models: [17, 49],
  apps: [77, 59],
  flows: [30, 62],
  automations: [83, 42],
  packages: [72, 76],
  archive: [43, 77],
  settings: [87, 78],
  personas: [65, 49],
  meetings: [15, 72]
};
var PLACE_KINDS = { apps: "app", flows: "flow", personas: "persona", automations: "automation", meetings: "meeting", archive: "artifact", packages: "package" };

// src/world/canonical/src/frontend/components/AvatarWorld/WorldScene.tsx
import { jsx as jsx2 } from "react/jsx-runtime";
var hash = (n) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};
var seed = (text) => [...text].reduce((value, char) => value * 31 + char.charCodeAt(0) >>> 0, 7);
function WorldScene(props) {
  const canvas = useRef(null);
  const current = useRef(props);
  current.current = props;
  const repaint = useRef(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element || /jsdom/i.test(navigator.userAgent)) return;
    const ctx = element.getContext("2d", { alpha: false });
    if (!ctx) return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = query.matches, frame = 0, last = 0, width = 1, height = 1, ratio = 1, life = 0;
    const pointer = { x: 0, y: 0 }, target = { x: 0, y: 0 };
    const resize = () => {
      width = element.clientWidth;
      height = element.clientHeight;
      ratio = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(25e5 / Math.max(1, width * height)));
      element.width = Math.max(1, Math.round(width * ratio));
      element.height = Math.max(1, Math.round(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(performance.now());
    };
    const draw = (now) => {
      const { snapshot, phase, level, exploring } = current.current;
      const t = reduced ? 0 : now / 1e3;
      const active = phase === "thinking" || phase === "usingApp";
      const destination = snapshot?.workModel?.ready || (snapshot?.objects.length ?? 0) > 0 ? 1 : 0;
      life = reduced ? destination : life + (destination - life) * 0.04;
      pointer.x += (target.x - pointer.x) * 0.035;
      pointer.y += (target.y - pointer.y) * 0.035;
      ctx.fillStyle = "#050607";
      ctx.fillRect(0, 0, width, height);
      const sky = ctx.createRadialGradient(width * 0.5, height * 0.42, 0, width * 0.5, height * 0.42, width * 0.65);
      sky.addColorStop(0, `rgba(184,198,202,${0.06 + life * 0.06})`);
      sky.addColorStop(0.55, "rgba(94,111,117,.025)");
      sky.addColorStop(1, "rgba(5,6,7,0)");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < 68; i++) {
        const x = hash(i + 1) * width, y = hash(i + 301) * height * 0.52;
        ctx.fillStyle = `rgba(230,235,236,${(0.04 + hash(i + 61) * 0.23) * (0.7 + Math.sin(t * 0.18 + i) * 0.3)})`;
        ctx.beginPath();
        ctx.arc(x + pointer.x * 3, y, 0.45 + hash(i + 120) * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      const ridge = (x, layer) => height * (0.52 + layer * 0.055) + Math.sin(x / width * 5.8 + layer * 0.8) * height * (0.027 + layer * 4e-3) + Math.sin(x / width * 10.2 + layer * 1.8) * height * 0.026;
      for (let layer = 0; layer < 5; layer++) {
        const shift = reduced ? 0 : pointer.x * (layer + 1) * 4;
        ctx.beginPath();
        ctx.moveTo(-20, height);
        for (let x = -20; x <= width + 20; x += 8) ctx.lineTo(x, ridge(x + shift, layer));
        ctx.lineTo(width + 20, height);
        ctx.closePath();
        const shade = 10 + layer * 3 + life * 2;
        ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 3})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(195,206,210,${0.035 + layer * 0.012})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        for (let row = 0; row < 14; row++) {
          ctx.beginPath();
          for (let x = -20; x <= width + 20; x += 10) {
            const y = ridge(x + shift, layer) + row * (4 + layer * 1.2) + Math.sin(x / 90 + row * 0.15) * row * 0.55;
            if (x === -20) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `rgba(184,198,203,${(0.012 + life * 8e-3) * (1 - row / 18)})`;
          ctx.lineWidth = 0.65;
          ctx.stroke();
        }
      }
      const streamX = (p) => width * (0.54 + Math.sin(p * 4.4 - 1.1) * (0.015 + p * 0.12)) + pointer.x * 12 * p;
      const streamY = (p) => height * (0.56 + p * 0.5);
      ctx.beginPath();
      for (let i = 0; i <= 100; i++) {
        const p = i / 100, x = streamX(p) - width * (1e-3 + p * p * 0.11), y = streamY(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let i = 100; i >= 0; i--) {
        const p = i / 100;
        ctx.lineTo(streamX(p) + width * (1e-3 + p * p * 0.11), streamY(p));
      }
      ctx.closePath();
      const water = ctx.createLinearGradient(0, height * 0.55, 0, height);
      water.addColorStop(0, "#69777b");
      water.addColorStop(0.3, "#243035");
      water.addColorStop(1, "#101719");
      ctx.fillStyle = water;
      ctx.globalAlpha = 0.3 + life * 0.4;
      ctx.fill();
      ctx.globalAlpha = 1;
      for (let i = 0; i < 56; i++) {
        const p = (i / 56 + t * (active ? 0.018 : 5e-3)) % 1;
        const spread = width * (1e-3 + p * p * 0.09), x = streamX(p), y = streamY(p);
        ctx.beginPath();
        ctx.ellipse(x + Math.sin(t * 0.3 + i) * spread * 0.4, y, spread * (0.15 + hash(i) * 0.6), 0.35 + p * 1.2, 0, 0, Math.PI);
        ctx.strokeStyle = `rgba(215,229,232,${(0.025 + hash(i + 50) * 0.1) * (0.4 + life * 0.6)})`;
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
      const size = Math.max(0.62, Math.min(1.3, width / 1e3));
      for (const place of Object.keys(LANDMARK_POSITIONS)) {
        const count = snapshot?.objects.filter((object) => object.kind === PLACE_KINDS[place]).length ?? 0;
        const inhabited = place === "models" ? Boolean(snapshot?.workModel?.ready) : place === "settings" || count > 0;
        const [px, py] = LANDMARK_POSITIONS[place];
        const x = Math.max(52, Math.min(width - 52, width * px / 100)), y = height * py / 100;
        ctx.save();
        ctx.translate(x, y - 12);
        ctx.scale(size, size);
        ctx.globalAlpha = inhabited ? 0.9 : 0.3;
        ctx.fillStyle = "rgba(0,0,0,.4)";
        ctx.beginPath();
        ctx.ellipse(4, 19, 48, 12, -0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#161c1f";
        ctx.beginPath();
        ctx.ellipse(0, 9, 38, 15, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#343d40";
        ctx.beginPath();
        ctx.ellipse(0, 4, 38, 13, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(190,206,209,.18)";
        ctx.lineWidth = 1;
        ctx.stroke();
        if (place === "models" || place === "meetings") {
          ctx.fillStyle = "#101619";
          ctx.beginPath();
          ctx.ellipse(0, 1, 26, 8, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = inhabited ? "#a6b8b9" : "#53666c";
          ctx.beginPath();
          ctx.ellipse(0, 0, 20, 5, 0, 0, Math.PI * 2);
          ctx.stroke();
          if (place === "models") {
            ctx.fillStyle = "#7c9297";
            ctx.beginPath();
            ctx.moveTo(-6, -1);
            ctx.quadraticCurveTo(-12, -25, 0, -40);
            ctx.quadraticCurveTo(14, -23, 6, -1);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = "#d1dedb";
            ctx.beginPath();
            ctx.ellipse(-2, -23, 3, 11, 0.2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            for (let i = 0; i < 4; i++) {
              const angle = i * Math.PI / 2 + 0.4;
              ctx.fillStyle = "#526165";
              ctx.beginPath();
              ctx.ellipse(Math.cos(angle) * 30, Math.sin(angle) * 9 - 4, 5, 6, 0, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        } else if (place === "apps") {
          ctx.fillStyle = "#566469";
          ctx.beginPath();
          ctx.moveTo(-30, -4);
          ctx.quadraticCurveTo(0, 22, 30, -4);
          ctx.lineTo(23, -8);
          ctx.lineTo(-23, -8);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = "#a4b2b4";
          ctx.beginPath();
          ctx.moveTo(0, -8);
          ctx.lineTo(0, -48);
          ctx.stroke();
          ctx.fillStyle = "#c6cecb";
          ctx.beginPath();
          ctx.moveTo(-2, -45);
          ctx.quadraticCurveTo(-26, -28, -2, -15);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#879796";
          ctx.beginPath();
          ctx.moveTo(3, -43);
          ctx.quadraticCurveTo(31, -28, 3, -18);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillStyle = "#293236";
          ctx.beginPath();
          ctx.roundRect(-22, -28, 39, 32, 6);
          ctx.fill();
          ctx.fillStyle = "#1b2529";
          ctx.beginPath();
          ctx.moveTo(17, -27);
          ctx.lineTo(31, -35);
          ctx.lineTo(31, -3);
          ctx.lineTo(17, 4);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#778386";
          ctx.beginPath();
          ctx.moveTo(-28, -27);
          ctx.quadraticCurveTo(-14, -48, -4, -51);
          ctx.lineTo(26, -41);
          ctx.lineTo(17, -23);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#455257";
          ctx.beginPath();
          ctx.moveTo(17, -23);
          ctx.lineTo(26, -41);
          ctx.lineTo(37, -32);
          ctx.lineTo(31, -27);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = inhabited ? "#d2d9c8" : "#4b595d";
          ctx.beginPath();
          ctx.roundRect(-13, -21, 8, 10, 3);
          ctx.fill();
          ctx.fillStyle = "#11191c";
          ctx.beginPath();
          ctx.roundRect(4, -14, 9, 18, 4);
          ctx.fill();
          if (place === "automations") {
            const running = snapshot?.objects.some((object) => object.kind === "automation" && object.state === "running");
            ctx.save();
            ctx.translate(1, -30);
            ctx.rotate(running ? t * 0.8 : 0);
            ctx.strokeStyle = "#b9c5c5";
            ctx.lineWidth = 3;
            for (let i = 0; i < 4; i++) {
              ctx.rotate(Math.PI / 2);
              ctx.beginPath();
              ctx.moveTo(3, 0);
              ctx.lineTo(24, 0);
              ctx.stroke();
            }
            ctx.restore();
            ctx.fillStyle = "#d5ded9";
            ctx.beginPath();
            ctx.arc(1, -30, 4, 0, Math.PI * 2);
            ctx.fill();
          }
          if (place === "archive") {
            ctx.fillStyle = "#536467";
            ctx.beginPath();
            ctx.roundRect(-33, -5, 14, 14, 3);
            ctx.fill();
            ctx.strokeStyle = "#9aabac";
            ctx.stroke();
          }
        }
        for (let i = 0; i < Math.min(count, 5); i++) {
          const tx = (i % 2 ? -1 : 1) * (32 + i * 6), ty = 3 + i * 3;
          ctx.strokeStyle = "#526c65";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.quadraticCurveTo(tx - 3, ty - 11, tx, ty - 19);
          ctx.stroke();
          ctx.fillStyle = "#89988c";
          ctx.beginPath();
          ctx.ellipse(tx - 4, ty - 15, 7, 3.5, -0.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.ellipse(tx + 4, ty - 22, 6, 3, 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      for (const object of snapshot?.objects.slice(0, 80) ?? []) {
        const id = seed(`${object.kind}:${object.id}`), p = 0.2 + hash(id) * 0.57;
        const side = hash(id + 3) > 0.5 ? 1 : -1;
        const x = streamX(p) + side * width * (0.04 + hash(id + 1) * 0.2), y = streamY(p) - height * 0.035;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 14 + p * 14);
        glow.addColorStop(0, "rgba(214,223,218,.10)");
        glow.addColorStop(1, "rgba(214,223,218,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(x - 30, y - 30, 60, 60);
        ctx.fillStyle = `rgba(228,232,222,${0.35 + 0.18 * Math.sin(t * 0.4 + hash(id) * 10)})`;
        ctx.beginPath();
        ctx.arc(x, y, 0.7 + p, 0, Math.PI * 2);
        ctx.fill();
      }
      const breath = phase === "speaking" || phase === "listening" ? level : active ? 0.18 + Math.sin(t * 1.6) * 0.06 : 0.02;
      const halo = ctx.createRadialGradient(width * 0.5, height * 0.52, 0, width * 0.5, height * 0.52, width * 0.26);
      halo.addColorStop(0, `rgba(215,229,228,${0.025 + breath * 0.055})`);
      halo.addColorStop(1, "rgba(215,229,228,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, width, height);
      const mist = ctx.createLinearGradient(0, height * 0.48, 0, height * 0.72);
      mist.addColorStop(0, "rgba(150,175,181,0)");
      mist.addColorStop(0.5, `rgba(150,175,181,${0.025 + life * 0.025})`);
      mist.addColorStop(1, "rgba(150,175,181,0)");
      ctx.fillStyle = mist;
      ctx.fillRect(0, 0, width, height);
      const vignette = ctx.createRadialGradient(width * 0.5, height * 0.48, width * 0.18, width * 0.5, height * 0.48, Math.max(width, height) * 0.65);
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, `rgba(0,0,0,${exploring ? 0.38 : 0.7})`);
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, width, height);
    };
    const tick = (now) => {
      if (document.hidden || reduced) {
        frame = 0;
        return;
      }
      if (now - last >= 40) {
        draw(now);
        last = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      draw(performance.now());
      if (!reduced && !document.hidden) frame = requestAnimationFrame(tick);
    };
    repaint.current = () => {
      if (reduced && !document.hidden) draw(performance.now());
    };
    const move = (event) => {
      if (reduced) return;
      target.x = (event.clientX / innerWidth - 0.5) * 2;
      target.y = (event.clientY / innerHeight - 0.5) * 2;
    };
    const motion = () => {
      reduced = query.matches;
      target.x = target.y = pointer.x = pointer.y = 0;
      resume();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("visibilitychange", resume);
    query.addEventListener("change", motion);
    resize();
    resume();
    return () => {
      repaint.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", move);
      document.removeEventListener("visibilitychange", resume);
      query.removeEventListener("change", motion);
    };
  }, []);
  useEffect(() => {
    repaint.current?.();
  }, [props.snapshot, props.phase, props.exploring]);
  return /* @__PURE__ */ jsx2("canvas", { ref: canvas, className: world_default.worldScene, "aria-hidden": "true" });
}

// src/world/WorldSky.tsx
import { useEffect as useEffect2, useId, useLayoutEffect, useRef as useRef2, useState } from "react";

// src/world/selection.ts
function currentWorldSkySelection(model, selection) {
  if (!model || !selection) return null;
  const source = model.sources.find((row) => row.id === selection.sourceId && row.factoryId === selection.factoryId);
  if (!source || source.status === "unavailable") return null;
  const records = source.snapshot?.snapshot;
  const present = selection.kind === "source" ? selection.id === source.id : selection.kind === "cell" ? records?.cells.some((row) => row.id === selection.id) : selection.kind === "task" ? records?.tasks.some((row) => row.id === selection.id) : selection.kind === "effect" && records?.effects.some((row) => row.key === selection.id);
  return present ? { sourceId: source.id, factoryId: source.factoryId, kind: selection.kind, id: selection.id } : null;
}

// src/world/world-sky.module.css
var world_sky_default = {
  shell: "world_sky_shell",
  panorama: "world_sky_panorama",
  world: "world_sky_world",
  sky: "world_sky_sky",
  camera: "world_sky_camera",
  selection: "world_sky_selection"
};

// src/world/WorldSky.tsx
import { jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
var copy = {
  en: { panorama: "World and sky", world: "FLUJO World", sky: "Swarm sky", up: "Look at the sky", down: "Back to the world", sample: "Sample data \xB7 sky preview", unavailable: "Swarm observations unavailable", sources: "registered sources" },
  es: { panorama: "Mundo y cielo", world: "FLUJO World", sky: "Cielo del enjambre", up: "Mirar al cielo", down: "Volver al mundo", sample: "Datos de ejemplo \xB7 vista del cielo", unavailable: "Observaciones del enjambre no disponibles", sources: "fuentes registradas" },
  pt: { panorama: "Mundo e c\xE9u", world: "FLUJO World", sky: "C\xE9u do enxame", up: "Olhar para o c\xE9u", down: "Voltar ao mundo", sample: "Dados de exemplo \xB7 pr\xE9via do c\xE9u", unavailable: "Observa\xE7\xF5es do enxame indispon\xEDveis", sources: "fontes registradas" }
};
var useClientLayoutEffect = typeof window === "undefined" ? useEffect2 : useLayoutEffect;
function WorldSky({ world, sky, model, selection, onNavigate, initialLayer = "world", locale = "en" }) {
  const viewport = useRef2(null), worldRegion = useRef2(null), skyRegion = useRef2(null);
  const [layer, setLayer] = useState(initialLayer);
  const layerRef = useRef2(initialLayer);
  const latest = useRef2({ model, selection, onNavigate });
  latest.current = { model, selection, onNavigate };
  const id = useId(), c = copy[locale];
  const visibleSelection = currentWorldSkySelection(model, selection);
  useClientLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const position = () => {
      element.scrollTop = layerRef.current === "world" ? element.clientHeight : 0;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const recordLayer = (next) => {
    if (next === layerRef.current) return;
    layerRef.current = next;
    setLayer(next);
    const facts = latest.current;
    facts.onNavigate({ layer: next, selection: currentWorldSkySelection(facts.model, facts.selection) });
  };
  const travel = (next) => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTo({
      top: next === "world" ? element.clientHeight : 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
    });
    (next === "world" ? worldRegion : skyRegion).current?.focus({ preventScroll: true });
  };
  return /* @__PURE__ */ jsxs2("div", { className: world_sky_default.shell, "data-layer": layer, children: [
    /* @__PURE__ */ jsxs2("nav", { className: world_sky_default.camera, "aria-label": c.panorama, children: [
      /* @__PURE__ */ jsxs2("button", { type: "button", "aria-controls": `${id}-${layer === "world" ? "sky" : "world"}`, onClick: () => travel(layer === "world" ? "sky" : "world"), children: [
        layer === "world" ? c.up : c.down,
        " ",
        /* @__PURE__ */ jsx3("span", { "aria-hidden": "true", children: layer === "world" ? "\u2191" : "\u2193" })
      ] }),
      /* @__PURE__ */ jsx3("small", { role: "status", children: model?.sample ? c.sample : !model ? c.unavailable : `${model.sources.length} ${c.sources}` })
    ] }),
    /* @__PURE__ */ jsxs2("div", { ref: viewport, className: world_sky_default.panorama, onScroll: (event) => {
      const element = event.currentTarget;
      if (element.clientHeight > 0) recordLayer(element.scrollTop >= element.clientHeight / 2 ? "world" : "sky");
    }, children: [
      /* @__PURE__ */ jsx3("section", { id: `${id}-sky`, ref: skyRegion, className: world_sky_default.sky, "aria-label": c.sky, tabIndex: -1, children: sky }),
      /* @__PURE__ */ jsx3("section", { id: `${id}-world`, ref: worldRegion, className: world_sky_default.world, "aria-label": c.world, tabIndex: -1, children: world })
    ] }),
    layer === "sky" && visibleSelection && /* @__PURE__ */ jsxs2("span", { className: world_sky_default.selection, children: [
      model?.sources.find((source) => source.id === visibleSelection.sourceId)?.label,
      " \xB7 ",
      visibleSelection.kind,
      " ",
      visibleSelection.id
    ] })
  ] });
}

// src/client/Eyes.tsx
import { useEffect as useEffect3, useRef as useRef3 } from "react";

// src/client/eyes.module.css
var eyes_default = {
  eyes: "eyes_eyes",
  eye: "eyes_eye",
  blink: "eyes_blink",
  eyeHalo: "eyes_eyeHalo",
  ponder: "eyes_ponder",
  speak: "eyes_speak",
  smallEyes: "eyes_smallEyes"
};

// src/client/Eyes.tsx
import { jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
function Eyes({ phase, avatar, small = false, level = 0 }) {
  const ref = useRef3(null);
  const state = useRef3(phase);
  state.current = phase;
  useEffect3(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, lastPointer = 0, x = 0, y = 0;
    const target = { x: 0, y: 0 };
    const move = (event) => {
      if (motion.matches) return;
      const rect = ref.current?.getBoundingClientRect();
      if (rect) {
        target.x = Math.max(-11, Math.min(11, (event.clientX - rect.x - rect.width / 2) / 45));
        target.y = Math.max(-7, Math.min(7, (event.clientY - rect.y - rect.height / 2) / 60));
        lastPointer = performance.now();
      }
    };
    const tick = (now) => {
      if (motion.matches || document.hidden) {
        frame = 0;
        return;
      }
      const resting = now - lastPointer > 2500;
      const working = state.current === "thinking" || state.current === "usingApp";
      x += ((resting ? working ? 6 + Math.sin(now / 1700) * 2 : Math.sin(now / 3700) * 2.5 : target.x) - x) * 0.09;
      y += ((resting ? working ? -3 : Math.cos(now / 4200) * 1.2 : target.y) - y) * 0.09;
      ref.current?.style.setProperty("--gaze-x", `${x.toFixed(2)}px`);
      ref.current?.style.setProperty("--gaze-y", `${y.toFixed(2)}px`);
      ref.current?.style.setProperty("--head-tilt", `${(x * -0.14).toFixed(2)}deg`);
      frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      if (!motion.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("visibilitychange", resume);
    motion.addEventListener("change", resume);
    resume();
    return () => {
      window.removeEventListener("pointermove", move);
      document.removeEventListener("visibilitychange", resume);
      motion.removeEventListener("change", resume);
      cancelAnimationFrame(frame);
    };
  }, []);
  return /* @__PURE__ */ jsxs3(
    "div",
    {
      ref,
      className: `${eyes_default.eyes} ${small ? eyes_default.smallEyes : ""}`,
      "data-phase": phase,
      "data-avatar": avatar,
      "aria-hidden": "true",
      style: { "--voice-level": Math.max(0, Math.min(1, level)), "--gaze-x": "0px", "--gaze-y": "0px" },
      children: [
        /* @__PURE__ */ jsx4("span", { className: eyes_default.eye, children: /* @__PURE__ */ jsx4("i", {}) }),
        /* @__PURE__ */ jsx4("span", { className: eyes_default.eye, children: /* @__PURE__ */ jsx4("i", {}) }),
        /* @__PURE__ */ jsx4("span", { className: eyes_default.eyeHalo })
      ]
    }
  );
}
export {
  Eyes,
  WorldScene,
  WorldSky,
  currentWorldSkySelection
};
